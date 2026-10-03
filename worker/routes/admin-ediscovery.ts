import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Address } from "@shared/types";
import type { AppEnv } from "../env";
import { requireFeature } from "../lib/features";
import { audit } from "../lib/audit";
import { discoveryWhere, EXPORT_MAX_BYTES, EXPORT_MAX_MESSAGES, exportStream, whereSql, zCriteria } from "../lib/ediscovery";
import type { AttachmentRow, MessageRow } from "../lib/messages";
import { newId, now, parseJson, sha256hex, timingSafeEqual } from "../lib/util";
import { parseBody } from "../lib/validate";
import { requireOwner } from "./admin-compliance";
import { attachmentResponse } from "./attachments";
import { buildDetail } from "./messages";

/**
 * eDiscovery: search, read and export mail across every mailbox. Admins have no
 * implicit access to other people's mail (see lib/access.ts), so this is an
 * explicit owner-only capability and every search, view and export is audited.
 */
export const adminEdiscoveryRoutes = new Hono<AppEnv>();
adminEdiscoveryRoutes.use("*", requireFeature("compliance"));
adminEdiscoveryRoutes.use("*", requireOwner);

const PAGE = 50;
const EXPORT_TTL_MS = 15 * 60_000;

interface ResultRow {
  id: string;
  mailbox_id: string;
  folder: string;
  direction: string;
  from_addr: string;
  from_name: string;
  to_json: string;
  subject: string;
  has_attachments: number;
  size: number;
  date: string;
  mailbox_address: string;
  mailbox_name: string;
  is_system: number;
}

adminEdiscoveryRoutes.post("/search", async (c) => {
  const body = await parseBody(c, z.object({ criteria: zCriteria, cursor: z.string().max(200).optional() }));
  const { where, args } = discoveryWhere(body.criteria);
  const pageWhere = [...where];
  const pageArgs = [...args];
  if (body.cursor) {
    const [cDate, cId] = atob(body.cursor).split("|");
    if (!cDate || !cId) throw new HTTPException(400, { message: "Bad cursor" });
    pageWhere.push("(m.date < ? OR (m.date = ? AND m.id < ?))");
    pageArgs.push(cDate, cDate, cId);
  }
  const db = c.env.DB;
  const [{ results }, total] = await Promise.all([
    db
      .prepare(
        `SELECT m.id, m.mailbox_id, m.folder, m.direction, m.from_addr, m.from_name, m.to_json, m.subject, m.has_attachments, m.size, m.date,
                mb.address AS mailbox_address, COALESCE(NULLIF(mb.name, ''), mb.display_name) AS mailbox_name, mb.is_system
         FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
         WHERE ${whereSql(pageWhere)} ORDER BY m.date DESC, m.id DESC LIMIT ?`,
      )
      .bind(...pageArgs, PAGE + 1)
      .all<ResultRow>(),
    body.cursor
      ? Promise.resolve(null)
      : db.prepare(`SELECT COUNT(*) AS n FROM messages m WHERE ${whereSql(where)}`).bind(...args).first<{ n: number }>(),
  ]);
  // Page turns are part of the same search; only the search itself is logged.
  if (!body.cursor) await audit(c, { action: "ediscovery.search", targetType: "messages", meta: { criteria: body.criteria, total: total?.n ?? 0 } });
  const page = results.slice(0, PAGE);
  const last = page[page.length - 1];
  return c.json({
    total: total?.n ?? null,
    items: page.map((r) => ({
      id: r.id,
      mailbox: r.is_system ? { id: r.mailbox_id, address: "Unrouted", name: "Unrouted" } : { id: r.mailbox_id, address: r.mailbox_address, name: r.mailbox_name },
      folder: r.folder,
      direction: r.direction,
      from: { email: r.from_addr, name: r.from_name || undefined },
      to: parseJson<Address[]>(r.to_json, []),
      subject: r.subject,
      hasAttachments: !!r.has_attachments,
      size: r.size,
      date: r.date,
    })),
    nextCursor: results.length > PAGE && last ? btoa(`${last.date}|${last.id}`) : null,
  });
});

adminEdiscoveryRoutes.get("/attachments/:id", async (c) => {
  const a = await c.env.DB.prepare("SELECT * FROM attachments WHERE id = ? AND message_id IS NOT NULL").bind(c.req.param("id")).first<AttachmentRow>();
  if (!a) throw new HTTPException(404, { message: "Attachment not found" });
  return attachmentResponse(c.env.FILES, a, c.req.query("download") === "1");
});

/** Read-only view of one result (same shape as Admin → All traffic). */
adminEdiscoveryRoutes.get("/:id", async (c) => {
  const m = await c.env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(c.req.param("id")).first<MessageRow>();
  if (!m) throw new HTTPException(404, { message: "Message not found" });
  const mb = await c.env.DB.prepare("SELECT id, address, COALESCE(NULLIF(name, ''), display_name) AS display_name, color, is_system FROM mailboxes WHERE id = ?")
    .bind(m.mailbox_id)
    .first<{ id: string; address: string; display_name: string; color: string; is_system: number }>();
  await audit(c, {
    action: "ediscovery.message_viewed",
    targetType: "message",
    targetId: m.id,
    meta: { mailbox: mb?.is_system ? "unrouted" : mb?.address, subject: m.subject },
  });
  return c.json({
    ...(await buildDetail(c, m)),
    mailbox: mb && !mb.is_system ? { id: mb.id, address: mb.address, displayName: mb.display_name, color: mb.color } : null,
  });
});

/**
 * Create a download link for the current results (newest first, at most
 * EXPORT_MAX_MESSAGES). The message set is fixed now; the link expires in 15 minutes
 * and only works for the owner who made it.
 */
adminEdiscoveryRoutes.post("/exports", async (c) => {
  const { criteria } = await parseBody(c, z.object({ criteria: zCriteria }));
  const { where, args } = discoveryWhere(criteria);
  const { results } = await c.env.DB.prepare(`SELECT m.id FROM messages m WHERE ${whereSql(where)} ORDER BY m.date DESC, m.id DESC LIMIT ?`)
    .bind(...args, EXPORT_MAX_MESSAGES + 1)
    .all<{ id: string }>();
  if (!results.length) throw new HTTPException(400, { message: "Nothing matches this search." });
  const capped = results.length > EXPORT_MAX_MESSAGES;
  const ids = results.slice(0, EXPORT_MAX_MESSAGES).map((r) => r.id);
  const id = newId();
  const token = newId(32);
  const expiresAt = new Date(Date.now() + EXPORT_TTL_MS).toISOString();
  const u = c.get("user");
  await c.env.DB.prepare(
    "INSERT INTO ediscovery_exports (id, token_hash, created_by, criteria, message_ids, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, await sha256hex(token), u.id, JSON.stringify(criteria), JSON.stringify(ids), expiresAt, now())
    .run();
  await audit(c, { action: "ediscovery.export_created", targetType: "export", targetId: id, meta: { criteria, count: ids.length, capped } });
  return c.json({
    url: `/api/admin/compliance/ediscovery/exports/${id}/download?token=${token}`,
    expiresAt,
    count: ids.length,
    capped,
    maxMessages: EXPORT_MAX_MESSAGES,
    maxBytes: EXPORT_MAX_BYTES,
  });
});

adminEdiscoveryRoutes.get("/exports/:id/download", async (c) => {
  const id = c.req.param("id");
  const token = c.req.query("token") ?? "";
  const row = await c.env.DB.prepare("SELECT * FROM ediscovery_exports WHERE id = ?").bind(id).first<{
    id: string;
    token_hash: string;
    created_by: string;
    message_ids: string;
    expires_at: string;
  }>();
  const u = c.get("user");
  if (!row || row.created_by !== u.id || !timingSafeEqual(await sha256hex(token), row.token_hash)) {
    throw new HTTPException(404, { message: "Export not found" });
  }
  if (row.expires_at < now()) throw new HTTPException(410, { message: "This download link has expired. Export again." });
  const ids = parseJson<string[]>(row.message_ids, []);
  await c.env.DB.prepare("UPDATE ediscovery_exports SET downloads = downloads + 1 WHERE id = ?").bind(id).run();
  await audit(c, { action: "ediscovery.export_downloaded", targetType: "export", targetId: id, meta: { count: ids.length } });
  return new Response(exportStream(c.env, ids), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="ediscovery-${now().slice(0, 10)}-${id.slice(0, 6)}.zip"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
