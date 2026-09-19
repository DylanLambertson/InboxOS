import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { MailboxRole } from "@shared/types";
import type { AppEnv } from "../env";
import { mailboxRole } from "../lib/access";
import { audit } from "../lib/audit";
import { purgeMessages } from "../lib/messages";
import { now } from "../lib/util";
import { parseBody, zId } from "../lib/validate";

export const messageActionRoutes = new Hono<AppEnv>();

const zAction = z.object({
  ids: z.array(zId).min(1).max(500),
  /** Apply to every message in each message's conversation (same folder). */
  thread: z.boolean().optional(),
  action: z.enum(["read", "unread", "star", "unstar", "move", "restore", "labelAdd", "labelRemove", "delete", "snooze"]),
  /** For snooze: when the conversation comes back to the inbox. */
  until: z.string().datetime({ offset: true }).optional(),
  folder: z.enum(["inbox", "archive", "spam", "trash"]).optional(),
  labelId: zId.optional(),
});

interface Row {
  id: string;
  mailbox_id: string;
  thread_id: string;
  folder: string;
  status: string;
}

messageActionRoutes.post("/bulk", async (c) => {
  const body = await parseBody(c, zAction);
  const u = c.get("user");
  const db = c.env.DB;

  // Load targets, then expand to whole conversations if asked.
  let rows: Row[] = [];
  for (let i = 0; i < body.ids.length; i += 90) {
    const chunk = body.ids.slice(i, i + 90);
    const { results } = await db
      .prepare(`SELECT id, mailbox_id, thread_id, folder, status FROM messages WHERE id IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .all<Row>();
    rows.push(...results);
  }
  if (body.thread) {
    const seen = new Set(rows.map((r) => r.id));
    const extra: Row[] = [];
    const keys = new Set(rows.map((r) => `${r.mailbox_id}|${r.thread_id}|${r.folder}`));
    for (const key of keys) {
      const [mb, th, folder] = key.split("|");
      // Reading a conversation marks all of it; moves only affect the folder you're looking at.
      const folderSql = ["read", "unread"].includes(body.action) ? "folder NOT IN ('trash','spam')" : "folder = ?";
      const stmt = db.prepare(`SELECT id, mailbox_id, thread_id, folder, status FROM messages WHERE mailbox_id = ? AND thread_id = ? AND ${folderSql}`);
      const { results } = await (folderSql.includes("?") ? stmt.bind(mb, th, folder) : stmt.bind(mb, th)).all<Row>();
      for (const r of results) if (!seen.has(r.id)) (seen.add(r.id), extra.push(r));
    }
    rows = rows.concat(extra);
  }
  if (!rows.length) throw new HTTPException(404, { message: "Messages not found" });

  // Permission check per mailbox.
  const needEditor = !["read", "unread", "star", "unstar"].includes(body.action);
  const roles = new Map<string, MailboxRole | null>();
  for (const mb of new Set(rows.map((r) => r.mailbox_id))) roles.set(mb, await mailboxRole(db, u.id, mb));
  for (const [, role] of roles) {
    if (!role) throw new HTTPException(404, { message: "Messages not found" });
    if (needEditor && role === "viewer") throw new HTTPException(403, { message: "You have read-only access to this mailbox." });
  }

  const t = now();
  const ids = rows.map((r) => r.id);
  const stmts: D1PreparedStatement[] = [];
  const each = (sql: string, ...extra: unknown[]) => {
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      stmts.push(db.prepare(sql.replace("$IDS", chunk.map(() => "?").join(","))).bind(...extra, ...chunk));
    }
  };

  switch (body.action) {
    case "read":
    case "unread":
      each("UPDATE messages SET is_read = ?, updated_at = ? WHERE id IN ($IDS)", body.action === "read" ? 1 : 0, t);
      break;
    case "star":
    case "unstar":
      each("UPDATE messages SET is_starred = ?, updated_at = ? WHERE id IN ($IDS)", body.action === "star" ? 1 : 0, t);
      break;
    case "move": {
      if (!body.folder) throw new HTTPException(400, { message: "folder is required" });
      if (rows.some((r) => r.folder === "drafts" || r.folder === "scheduled") && body.folder !== "trash") {
        throw new HTTPException(400, { message: "Drafts and scheduled messages can only be deleted." });
      }
      if (rows.some((r) => r.folder === "scheduled")) {
        throw new HTTPException(400, { message: "Cancel the scheduled send first." });
      }
      if (body.folder === "trash") {
        each(
          `UPDATE messages SET folder_before_trash = CASE WHEN folder = 'trash' THEN folder_before_trash ELSE folder END,
             folder = 'trash', trashed_at = ?, updated_at = ? WHERE id IN ($IDS)`,
          t,
          t,
        );
      } else {
        // Sent mail keeps living in Sent unless explicitly moved; inbound spam report marks as read.
        each(
          `UPDATE messages SET folder = ?, trashed_at = NULL, folder_before_trash = NULL, snoozed_until = NULL,
             is_read = CASE WHEN ? = 'spam' THEN 1 ELSE is_read END, updated_at = ? WHERE id IN ($IDS)`,
          body.folder,
          body.folder,
          t,
        );
      }
      break;
    }
    case "snooze": {
      const until = body.until ? new Date(body.until) : null;
      if (!until || until.getTime() < Date.now() + 60_000 || until.getTime() > Date.now() + 366 * 86_400_000) {
        throw new HTTPException(400, { message: "Pick a time between a minute and a year from now." });
      }
      if (rows.some((r) => !["inbox", "archive", "snoozed"].includes(r.folder))) {
        throw new HTTPException(400, { message: "Only inbox and archived mail can be snoozed." });
      }
      each("UPDATE messages SET folder = 'snoozed', snoozed_until = ?, updated_at = ? WHERE id IN ($IDS)", until.toISOString(), t);
      break;
    }
    case "restore":
      each(
        `UPDATE messages SET folder = COALESCE(folder_before_trash, CASE WHEN direction = 'outbound' THEN 'sent' ELSE 'inbox' END),
           folder_before_trash = NULL, trashed_at = NULL, updated_at = ? WHERE id IN ($IDS)`,
        t,
      );
      break;
    case "labelAdd":
    case "labelRemove": {
      if (!body.labelId) throw new HTTPException(400, { message: "labelId is required" });
      const label = await db.prepare("SELECT mailbox_id FROM labels WHERE id = ?").bind(body.labelId).first<{ mailbox_id: string }>();
      if (!label || rows.some((r) => r.mailbox_id !== label.mailbox_id)) {
        throw new HTTPException(400, { message: "Label belongs to a different mailbox." });
      }
      for (const id of ids) {
        stmts.push(
          body.action === "labelAdd"
            ? db.prepare("INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?, ?)").bind(id, body.labelId)
            : db.prepare("DELETE FROM message_labels WHERE message_id = ? AND label_id = ?").bind(id, body.labelId),
        );
      }
      break;
    }
    case "delete": {
      // Permanent delete is only allowed from Trash/Spam, or for drafts (discard).
      if (rows.some((r) => !["trash", "spam", "drafts"].includes(r.folder))) {
        throw new HTTPException(400, { message: "Move messages to Trash before deleting them forever." });
      }
      await purgeMessages(db, c.env.FILES, ids);
      await audit(c, { action: "message.deleted", targetType: "message", meta: { count: ids.length, mailboxes: [...roles.keys()] } });
      return c.json({ ok: true, count: ids.length });
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return c.json({ ok: true, count: ids.length });
});

/** Empty Trash or Spam for a mailbox. */
messageActionRoutes.post("/empty", async (c) => {
  const body = await parseBody(c, z.object({ mailboxId: zId, folder: z.enum(["trash", "spam"]) }));
  const u = c.get("user");
  const role = await mailboxRole(c.env.DB, u.id, body.mailboxId);
  if (!role || role === "viewer") throw new HTTPException(403, { message: "Not allowed" });
  const { results } = await c.env.DB.prepare("SELECT id FROM messages WHERE mailbox_id = ? AND folder = ? LIMIT 2000")
    .bind(body.mailboxId, body.folder)
    .all<{ id: string }>();
  await purgeMessages(c.env.DB, c.env.FILES, results.map((r) => r.id));
  await audit(c, { action: `mailbox.emptied_${body.folder}`, targetType: "mailbox", targetId: body.mailboxId, meta: { count: results.length } });
  return c.json({ ok: true, count: results.length });
});
