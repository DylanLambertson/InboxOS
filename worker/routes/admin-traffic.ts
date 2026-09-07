import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { UNROUTED_MAILBOX_ID, type Address } from "@shared/types";
import type { AppEnv } from "../env";
import { audit } from "../lib/audit";
import { purgeMessages, resolveThread, type AttachmentRow, type MessageRow } from "../lib/messages";
import { ftsExpression, likeEscape } from "../lib/search";
import { clampInt, now, parseJson } from "../lib/util";
import { parseBody, zEmail, zId } from "../lib/validate";
import { attachmentResponse } from "./attachments";
import { buildDetail } from "./messages";

/**
 * Admin → All traffic: every message sent or received across the organization,
 * including mail for addresses that have no mailbox. Opening a message is audited.
 */
export const adminTrafficRoutes = new Hono<AppEnv>();

const PROBLEM = "('bounced','complained','failed','delivery_delayed','suppressed')";

interface TrafficRow {
  id: string;
  mailbox_id: string;
  direction: "inbound" | "outbound";
  folder: string;
  status: string;
  from_addr: string;
  from_name: string;
  to_json: string;
  cc_json: string;
  subject: string;
  snippet: string;
  has_attachments: number;
  size: number;
  date: string;
  mailbox_address: string;
  mailbox_name: string;
  mailbox_color: string;
  is_system: number;
}

adminTrafficRoutes.get("/", async (c) => {
  const scope = c.req.query("scope") ?? "all"; // all | inbound | outbound | unrouted | problems
  const mailboxId = c.req.query("mailbox") ?? "";
  const q = (c.req.query("q") ?? "").trim().slice(0, 300);
  const csv = c.req.query("format") === "csv";
  const limit = csv ? 5000 : clampInt(c.req.query("limit"), 1, 200, 50);
  const cursor = c.req.query("cursor") ?? "";
  const [cDate, cId] = cursor ? atob(cursor).split("|") : ["", ""];

  const where = ["m.folder NOT IN ('drafts')", "m.status != 'draft'"];
  const args: unknown[] = [];
  if (scope === "inbound") where.push("m.direction = 'inbound'");
  if (scope === "outbound") where.push("m.direction = 'outbound'");
  if (scope === "unrouted") where.push(`m.mailbox_id = '${UNROUTED_MAILBOX_ID}'`);
  if (scope === "problems") where.push(`m.status IN ${PROBLEM}`);
  if (mailboxId) {
    where.push("m.mailbox_id = ?");
    args.push(mailboxId);
  }
  if (q) {
    const pat = `%${likeEscape(q.toLowerCase())}%`;
    const fts = ftsExpression(q.split(/\s+/));
    where.push(
      `(m.from_addr LIKE ? ESCAPE '\\' OR m.to_json LIKE ? ESCAPE '\\' OR m.cc_json LIKE ? ESCAPE '\\' OR m.bcc_json LIKE ? ESCAPE '\\'
        OR m.subject LIKE ? ESCAPE '\\'${fts ? " OR m.id IN (SELECT message_id FROM messages_fts WHERE messages_fts MATCH ?)" : ""})`,
    );
    args.push(pat, pat, pat, pat, pat, ...(fts ? [fts] : []));
  }
  if (cDate && cId) {
    where.push("(m.date < ? OR (m.date = ? AND m.id < ?))");
    args.push(cDate, cDate, cId);
  }

  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.mailbox_id, m.direction, m.folder, m.status, m.from_addr, m.from_name, m.to_json, m.cc_json, m.subject, m.snippet,
            m.has_attachments, m.size, m.date, mb.address AS mailbox_address, COALESCE(NULLIF(mb.name, ''), mb.display_name) AS mailbox_name, mb.color AS mailbox_color, mb.is_system
     FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
     WHERE ${where.join(" AND ")}
     ORDER BY m.date DESC, m.id DESC LIMIT ?`,
  )
    .bind(...args, limit + 1)
    .all<TrafficRow>();

  if (csv) {
    const esc = (v: string) => {
      const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = results.map((r) =>
      [r.date, r.direction, r.is_system ? "unrouted" : r.mailbox_address, r.from_addr, parseJson<Address[]>(r.to_json, []).map((a) => a.email).join("; "), r.subject, r.status, String(r.size)]
        .map(esc)
        .join(","),
    );
    return new Response(["date,direction,mailbox,from,to,subject,status,bytes", ...lines].join("\n"), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="traffic-${now().slice(0, 10)}.csv"` },
    });
  }

  const page = results.slice(0, limit);
  const last = page[page.length - 1];
  return c.json({
    items: page.map((r) => ({
      id: r.id,
      direction: r.direction,
      status: r.status,
      folder: r.folder,
      from: { email: r.from_addr, name: r.from_name || undefined },
      to: parseJson<Address[]>(r.to_json, []),
      cc: parseJson<Address[]>(r.cc_json, []),
      subject: r.subject,
      snippet: r.snippet,
      hasAttachments: !!r.has_attachments,
      size: r.size,
      date: r.date,
      mailbox: r.is_system ? null : { id: r.mailbox_id, address: r.mailbox_address, displayName: r.mailbox_name, color: r.mailbox_color },
    })),
    nextCursor: results.length > limit && last ? btoa(`${last.date}|${last.id}`) : null,
  });
});

adminTrafficRoutes.get("/stats", async (c) => {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const row = await c.env.DB.prepare(
    `SELECT
       SUM(CASE WHEN direction = 'inbound' AND date >= ?1 THEN 1 ELSE 0 END) AS inbound,
       SUM(CASE WHEN direction = 'outbound' AND status != 'draft' AND folder != 'drafts' AND date >= ?1 THEN 1 ELSE 0 END) AS outbound,
       SUM(CASE WHEN mailbox_id = '${UNROUTED_MAILBOX_ID}' THEN 1 ELSE 0 END) AS unrouted,
       SUM(CASE WHEN status IN ${PROBLEM} AND date >= ?1 THEN 1 ELSE 0 END) AS problems
     FROM messages`,
  )
    .bind(since)
    .first<Record<string, number | null>>();
  return c.json({ inbound: row?.inbound ?? 0, outbound: row?.outbound ?? 0, unrouted: row?.unrouted ?? 0, problems: row?.problems ?? 0 });
});

async function loadMessage(db: D1Database, id: string): Promise<MessageRow> {
  const m = await db.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first<MessageRow>();
  if (!m) throw new HTTPException(404, { message: "Message not found" });
  return m;
}

adminTrafficRoutes.get("/attachments/:id", async (c) => {
  const a = await c.env.DB.prepare("SELECT * FROM attachments WHERE id = ? AND message_id IS NOT NULL").bind(c.req.param("id")).first<AttachmentRow>();
  if (!a) throw new HTTPException(404, { message: "Attachment not found" });
  return attachmentResponse(c.env.FILES, a, c.req.query("download") === "1");
});

adminTrafficRoutes.get("/:id", async (c) => {
  const m = await loadMessage(c.env.DB, c.req.param("id"));
  const mb = await c.env.DB.prepare("SELECT id, address, COALESCE(NULLIF(name, ''), display_name) AS display_name, color, is_system FROM mailboxes WHERE id = ?")
    .bind(m.mailbox_id)
    .first<{ id: string; address: string; display_name: string; color: string; is_system: number }>();
  await audit(c, { action: "admin.message_viewed", targetType: "message", targetId: m.id, meta: { mailbox: mb?.is_system ? "unrouted" : mb?.address, subject: m.subject } });
  return c.json({
    ...(await buildDetail(c, m)),
    mailbox: mb && !mb.is_system ? { id: mb.id, address: mb.address, displayName: mb.display_name, color: mb.color } : null,
  });
});

/** Move an unrouted message into a real mailbox, optionally routing that address there from now on. */
adminTrafficRoutes.post("/:id/deliver", async (c) => {
  const body = await parseBody(c, z.object({ mailboxId: zId, aliasAddress: zEmail.optional() }));
  const m = await loadMessage(c.env.DB, c.req.param("id"));
  if (m.mailbox_id !== UNROUTED_MAILBOX_ID) throw new HTTPException(409, { message: "Only unrouted messages can be delivered." });
  const target = await c.env.DB.prepare("SELECT address FROM mailboxes WHERE id = ? AND is_system = 0").bind(body.mailboxId).first<{ address: string }>();
  if (!target) throw new HTTPException(404, { message: "Mailbox not found" });

  const threadId = await resolveThread(c.env.DB, body.mailboxId, {
    inReplyTo: m.in_reply_to,
    references: m.references_header,
    subject: m.subject,
    participants: [m.from_addr],
  });
  const t = now();
  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare("UPDATE messages SET mailbox_id = ?, thread_id = ?, folder = 'inbox', is_read = 0, updated_at = ? WHERE id = ?").bind(body.mailboxId, threadId, t, m.id),
    c.env.DB.prepare("UPDATE attachments SET mailbox_id = ? WHERE message_id = ?").bind(body.mailboxId, m.id),
  ];
  if (body.aliasAddress) {
    const taken = await c.env.DB.prepare("SELECT 1 FROM mailboxes WHERE address = ?1 UNION SELECT 1 FROM mailbox_aliases WHERE address = ?1")
      .bind(body.aliasAddress)
      .first();
    if (taken) throw new HTTPException(409, { message: `${body.aliasAddress} already belongs to a mailbox.` });
    stmts.push(c.env.DB.prepare("INSERT INTO mailbox_aliases (address, mailbox_id, created_at) VALUES (?, ?, ?)").bind(body.aliasAddress, body.mailboxId, t));
  }
  await c.env.DB.batch(stmts);
  await audit(c, {
    action: "admin.message_delivered",
    targetType: "message",
    targetId: m.id,
    meta: { to: target.address, aliasAdded: body.aliasAddress ?? null },
  });
  return c.json({ ok: true });
});

adminTrafficRoutes.delete("/:id", async (c) => {
  const m = await loadMessage(c.env.DB, c.req.param("id"));
  if (m.mailbox_id !== UNROUTED_MAILBOX_ID) throw new HTTPException(409, { message: "Only unrouted messages can be deleted here. Mailbox owners manage their own mail." });
  await purgeMessages(c.env.DB, c.env.FILES, [m.id]);
  await audit(c, { action: "admin.message_deleted", targetType: "message", targetId: m.id, meta: { subject: m.subject, from: m.from_addr } });
  return c.json({ ok: true });
});
