import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Label, MailboxRole, MailboxSummary, MailboxType } from "@shared/types";
import type { AppEnv } from "../env";
import { requireMailbox } from "../lib/access";
import { audit } from "../lib/audit";
import { autoReplyActive, normalizeBlockPattern, parseAutoReply } from "../lib/mail-rules";
import { likeEscape } from "../lib/search";
import { newId, now } from "../lib/util";
import { parseBody, zColor } from "../lib/validate";

export const mailboxRoutes = new Hono<AppEnv>();

mailboxRoutes.get("/", async (c) => {
  const u = c.get("user");
  const { results: boxes } = await c.env.DB.prepare(
    `SELECT m.id, m.address, m.name, m.display_name, m.type, m.color, m.signature_html, mm.role
     FROM mailbox_members mm JOIN mailboxes m ON m.id = mm.mailbox_id
     WHERE mm.user_id = ? AND m.is_active = 1
     ORDER BY m.type = 'shared', m.address`,
  )
    .bind(u.id)
    .all<{ id: string; address: string; name: string; display_name: string; type: MailboxType; color: string; signature_html: string; role: MailboxRole }>();
  if (!boxes.length) return c.json([]);

  const ids = boxes.map((b) => b.id);
  const ph = ids.map(() => "?").join(",");
  const [{ results: counts }, { results: aliases }] = await Promise.all([
    c.env.DB.prepare(
      `SELECT mailbox_id, folder, SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread, COUNT(*) AS total
       FROM messages WHERE mailbox_id IN (${ph}) AND folder IN ('inbox','spam','drafts','scheduled','snoozed')
       GROUP BY mailbox_id, folder`,
    )
      .bind(...ids)
      .all<{ mailbox_id: string; folder: string; unread: number; total: number }>(),
    c.env.DB.prepare(`SELECT address, mailbox_id FROM mailbox_aliases WHERE mailbox_id IN (${ph}) ORDER BY address`)
      .bind(...ids)
      .all<{ address: string; mailbox_id: string }>(),
  ]);

  const out: MailboxSummary[] = boxes.map((b) => {
    const unread: Record<string, number> = {};
    for (const r of counts.filter((x) => x.mailbox_id === b.id)) {
      unread[r.folder] = r.folder === "drafts" || r.folder === "scheduled" || r.folder === "snoozed" ? r.total : r.unread;
    }
    return {
      id: b.id,
      address: b.address,
      name: b.name,
      displayName: b.display_name,
      type: b.type,
      color: b.color,
      role: b.role,
      signatureHtml: b.signature_html,
      unread,
      aliases: aliases.filter((a) => a.mailbox_id === b.id).map((a) => a.address),
    };
  });
  return c.json(out);
});

mailboxRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const u = c.get("user");
  await requireMailbox(c.env.DB, u, id, "owner");
  const body = await parseBody(
    c,
    z.object({
      name: z.string().trim().max(80).optional(),
      displayName: z.string().trim().max(120).optional(),
      signatureHtml: z.string().max(20_000).optional(),
      color: zColor.optional(),
    }),
  );
  await c.env.DB.prepare(
    `UPDATE mailboxes SET name = COALESCE(?, name), display_name = COALESCE(?, display_name), signature_html = COALESCE(?, signature_html),
       color = COALESCE(?, color), updated_at = ? WHERE id = ?`,
  )
    .bind(body.name ?? null, body.displayName ?? null, body.signatureHtml ?? null, body.color ?? null, now(), id)
    .run();
  await audit(c, { action: "mailbox.updated", targetType: "mailbox", targetId: id, meta: { fields: Object.keys(body) } });
  return c.json({ ok: true });
});

// ---- Auto-reply & blocked senders -------------------------------------------

mailboxRoutes.get("/:id/autoreply", async (c) => {
  const id = c.req.param("id");
  await requireMailbox(c.env.DB, c.get("user"), id);
  const row = await c.env.DB.prepare("SELECT autoreply_json FROM mailboxes WHERE id = ?").bind(id).first<{ autoreply_json: string | null }>();
  const rule = parseAutoReply(row?.autoreply_json);
  return c.json({ ...rule, active: autoReplyActive(rule) });
});

mailboxRoutes.put("/:id/autoreply", async (c) => {
  const id = c.req.param("id");
  await requireMailbox(c.env.DB, c.get("user"), id, "editor");
  const zDate = z.string().datetime({ offset: true }).nullable();
  const body = await parseBody(
    c,
    z.object({
      enabled: z.boolean(),
      subject: z.string().trim().max(200).default(""),
      message: z.string().max(5000).default(""),
      startsAt: zDate.default(null),
      endsAt: zDate.default(null),
    }),
  );
  if (body.enabled && !body.message.trim()) throw new HTTPException(400, { message: "Write the auto-reply message first." });
  const rule = {
    ...body,
    startsAt: body.startsAt ? new Date(body.startsAt).toISOString() : null,
    endsAt: body.endsAt ? new Date(body.endsAt).toISOString() : null,
  };
  if (rule.startsAt && rule.endsAt && rule.endsAt <= rule.startsAt) throw new HTTPException(400, { message: "The end must be after the start." });
  await c.env.DB.prepare("UPDATE mailboxes SET autoreply_json = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(rule), now(), id).run();
  // A fresh vacation starts fresh: everyone gets the new message once.
  if (rule.enabled) await c.env.DB.prepare("DELETE FROM autoreply_log WHERE mailbox_id = ?").bind(id).run();
  await audit(c, { action: rule.enabled ? "mailbox.autoreply_on" : "mailbox.autoreply_off", targetType: "mailbox", targetId: id, meta: { endsAt: rule.endsAt } });
  return c.json({ ...rule, active: autoReplyActive(rule) });
});

mailboxRoutes.get("/:id/blocked", async (c) => {
  const id = c.req.param("id");
  await requireMailbox(c.env.DB, c.get("user"), id);
  const { results } = await c.env.DB.prepare("SELECT pattern, created_at FROM blocked_senders WHERE mailbox_id = ? ORDER BY pattern")
    .bind(id)
    .all<{ pattern: string; created_at: string }>();
  return c.json(results.map((r) => ({ pattern: r.pattern, createdAt: r.created_at })));
});

mailboxRoutes.post("/:id/blocked", async (c) => {
  const id = c.req.param("id");
  const u = c.get("user");
  await requireMailbox(c.env.DB, u, id, "editor");
  const body = await parseBody(c, z.object({ pattern: z.string().max(320), moveExisting: z.boolean().default(false) }));
  const pattern = normalizeBlockPattern(body.pattern);
  if (!pattern) throw new HTTPException(400, { message: "Enter an email address or a domain like @example.com." });
  const t = now();
  const match = pattern.startsWith("@") ? "lower(from_addr) LIKE ? ESCAPE '\\'" : "lower(from_addr) = ?";
  const value = pattern.startsWith("@") ? `%${likeEscape(pattern)}` : pattern;
  const stmts = [
    c.env.DB.prepare("INSERT OR IGNORE INTO blocked_senders (mailbox_id, pattern, created_by, created_at) VALUES (?, ?, ?, ?)").bind(id, pattern, u.id, t),
  ];
  if (body.moveExisting) {
    stmts.push(
      c.env.DB.prepare(`UPDATE messages SET folder = 'spam', updated_at = ? WHERE mailbox_id = ? AND direction = 'inbound' AND folder IN ('inbox','archive') AND ${match}`).bind(
        t,
        id,
        value,
      ),
    );
  }
  const res = await c.env.DB.batch(stmts);
  await audit(c, { action: "mailbox.sender_blocked", targetType: "mailbox", targetId: id, meta: { pattern } });
  return c.json({ pattern, moved: body.moveExisting ? (res[1]?.meta.changes ?? 0) : 0 }, 201);
});

mailboxRoutes.delete("/:id/blocked/:pattern", async (c) => {
  const id = c.req.param("id");
  await requireMailbox(c.env.DB, c.get("user"), id, "editor");
  const pattern = decodeURIComponent(c.req.param("pattern")).toLowerCase();
  await c.env.DB.prepare("DELETE FROM blocked_senders WHERE mailbox_id = ? AND pattern = ?").bind(id, pattern).run();
  await audit(c, { action: "mailbox.sender_unblocked", targetType: "mailbox", targetId: id, meta: { pattern } });
  return c.json({ ok: true });
});

// ---- Labels ---------------------------------------------------------------

const toLabel = (r: { id: string; mailbox_id: string; name: string; color: string }): Label => ({
  id: r.id,
  mailboxId: r.mailbox_id,
  name: r.name,
  color: r.color,
});

mailboxRoutes.get("/:id/labels", async (c) => {
  const id = c.req.param("id");
  await requireMailbox(c.env.DB, c.get("user"), id);
  const { results } = await c.env.DB.prepare("SELECT * FROM labels WHERE mailbox_id = ? ORDER BY name COLLATE NOCASE")
    .bind(id)
    .all<{ id: string; mailbox_id: string; name: string; color: string }>();
  return c.json(results.map(toLabel));
});

const zLabel = z.object({ name: z.string().trim().min(1).max(60), color: zColor });

mailboxRoutes.post("/:id/labels", async (c) => {
  const mailboxId = c.req.param("id");
  await requireMailbox(c.env.DB, c.get("user"), mailboxId, "editor");
  const body = await parseBody(c, zLabel);
  const id = newId();
  try {
    await c.env.DB.prepare("INSERT INTO labels (id, mailbox_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(id, mailboxId, body.name, body.color, now())
      .run();
  } catch {
    throw new HTTPException(409, { message: "A label with that name already exists." });
  }
  return c.json(toLabel({ id, mailbox_id: mailboxId, ...body }), 201);
});

export const labelRoutes = new Hono<AppEnv>();

async function loadLabel(db: D1Database, id: string) {
  const l = await db.prepare("SELECT * FROM labels WHERE id = ?").bind(id).first<{ id: string; mailbox_id: string; name: string; color: string }>();
  if (!l) throw new HTTPException(404, { message: "Label not found" });
  return l;
}

labelRoutes.patch("/:id", async (c) => {
  const l = await loadLabel(c.env.DB, c.req.param("id"));
  await requireMailbox(c.env.DB, c.get("user"), l.mailbox_id, "editor");
  const body = await parseBody(c, zLabel.partial());
  await c.env.DB.prepare("UPDATE labels SET name = COALESCE(?, name), color = COALESCE(?, color) WHERE id = ?")
    .bind(body.name ?? null, body.color ?? null, l.id)
    .run();
  return c.json({ ok: true });
});

labelRoutes.delete("/:id", async (c) => {
  const l = await loadLabel(c.env.DB, c.req.param("id"));
  await requireMailbox(c.env.DB, c.get("user"), l.mailbox_id, "editor");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM message_labels WHERE label_id = ?").bind(l.id),
    c.env.DB.prepare("DELETE FROM labels WHERE id = ?").bind(l.id),
  ]);
  return c.json({ ok: true });
});
