import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Address, Folder } from "@shared/types";
import type { AppEnv } from "../env";
import { apiActor, type ApiScope, mailboxAllowed, requireScope } from "./apikeys";
import { audit } from "./audit";
import type { MessageRow } from "./messages";
import { likeEscape } from "./search";
import { quotaUsage } from "./send";
import { newId, now, parseJson } from "./util";

/** Operations behind the REST API (/api/v1) and the MCP tools, scoped to the calling API key. */

export async function allowedMailboxes(c: Context<AppEnv>) {
  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.address, m.name, m.display_name, m.type,
       (SELECT group_concat(address) FROM mailbox_aliases a WHERE a.mailbox_id = m.id) AS aliases
     FROM mailboxes m WHERE m.is_active = 1 AND m.is_system = 0 ORDER BY m.address`,
  ).all<{ id: string; address: string; name: string; display_name: string; type: string; aliases: string | null }>();
  return results
    .filter((m) => mailboxAllowed(c, m.id))
    .map((m) => ({ id: m.id, address: m.address, name: m.name, senderName: m.display_name, type: m.type, aliases: m.aliases ? m.aliases.split(",") : [] }));
}

// ---- Contacts ---------------------------------------------------------------

interface ContactRow {
  id: string;
  email: string;
  name: string;
  company: string;
  title: string;
  website: string;
  notes: string;
  tags: string;
  is_saved: number;
  times_contacted: number;
  last_contacted_at: string | null;
  suppressed: string | null;
}

const toContact = (r: ContactRow) => ({
  email: r.email,
  name: r.name,
  company: r.company,
  title: r.title,
  website: r.website,
  notes: r.notes,
  tags: parseJson<string[]>(r.tags, []),
  saved: !!r.is_saved,
  timesContacted: r.times_contacted,
  lastContactedAt: r.last_contacted_at,
  doNotEmail: r.suppressed,
});

const CONTACT_SELECT = `SELECT c.*, s.reason AS suppressed FROM contacts c LEFT JOIN suppressions s ON s.email = c.email`;

export async function searchContacts(c: Context<AppEnv>, opts: { query?: string; tag?: string; savedOnly?: boolean; limit?: number }) {
  requireScope(c.get("apiKey"), "contacts");
  const q = (opts.query ?? "").trim().toLowerCase();
  const pat = `%${likeEscape(q)}%`;
  const tag = (opts.tag ?? "").trim().toLowerCase();
  const { results } = await c.env.DB.prepare(
    `${CONTACT_SELECT}
     WHERE (?1 = '' OR c.email LIKE ?2 ESCAPE '\\' OR c.name LIKE ?2 ESCAPE '\\' OR c.company LIKE ?2 ESCAPE '\\' OR c.notes LIKE ?2 ESCAPE '\\')
       AND (?3 = '' OR c.tags LIKE ?4 ESCAPE '\\')
       AND (?5 = 0 OR c.is_saved = 1)
     ORDER BY c.is_saved DESC, c.updated_at DESC LIMIT ?6`,
  )
    .bind(q, pat, tag, `%"${likeEscape(tag)}"%`, opts.savedOnly ? 1 : 0, Math.min(Math.max(opts.limit ?? 50, 1), 200))
    .all<ContactRow>();
  return results.map(toContact);
}

export interface ContactInput {
  email: string;
  name?: string;
  company?: string;
  title?: string;
  website?: string;
  notes?: string;
  tags?: string[];
}

/** Create or update contacts. Only the fields given are changed. */
export async function saveContacts(c: Context<AppEnv>, contacts: ContactInput[]) {
  const key = c.get("apiKey");
  requireScope(key, "contacts");
  const db = c.env.DB;
  const t = now();
  const tags = (x?: string[]) => (x ? JSON.stringify([...new Set(x.map((s) => s.trim().toLowerCase()).filter(Boolean))].slice(0, 30)) : null);
  const { results: before } = await db
    .prepare(`SELECT email FROM contacts WHERE email IN (${contacts.map(() => "?").join(",")})`)
    .bind(...contacts.map((x) => x.email))
    .all<{ email: string }>();
  await db.batch(
    contacts.map((x) =>
      db
        .prepare(
          `INSERT INTO contacts (id, email, name, company, title, website, notes, tags, is_saved, created_at, updated_at)
           VALUES (?1, ?2, COALESCE(?3, ''), COALESCE(?4, ''), COALESCE(?5, ''), COALESCE(?6, ''), COALESCE(?7, ''), COALESCE(?8, '[]'), 1, ?9, ?9)
           ON CONFLICT(email) DO UPDATE SET
             name = COALESCE(?3, contacts.name), company = COALESCE(?4, contacts.company), title = COALESCE(?5, contacts.title),
             website = COALESCE(?6, contacts.website), notes = COALESCE(?7, contacts.notes), tags = COALESCE(?8, contacts.tags),
             is_saved = 1, updated_at = ?9`,
        )
        .bind(newId(), x.email, x.name ?? null, x.company ?? null, x.title ?? null, x.website ?? null, x.notes ?? null, tags(x.tags), t),
    ),
  );
  const existing = new Set(before.map((b) => b.email.toLowerCase()));
  const created = contacts.filter((x) => !existing.has(x.email)).length;
  await audit(c, { action: "api.contacts_saved", targetType: "contact", meta: { created, updated: contacts.length - created, apiKey: key.name }, actor: apiActor(c) });
  return { created, updated: contacts.length - created };
}

export async function deleteContact(c: Context<AppEnv>, email: string) {
  const key = c.get("apiKey");
  requireScope(key, "contacts");
  const res = await c.env.DB.prepare("DELETE FROM contacts WHERE email = ?").bind(email).run();
  if (!res.meta.changes) throw new HTTPException(404, { message: `No contact ${email}` });
  await audit(c, { action: "api.contact_deleted", targetType: "contact", targetId: email, meta: { apiKey: key.name }, actor: apiActor(c) });
  return { deleted: email };
}

/** A contact plus the recent conversation history with them (for personalization and follow-ups). */
export async function getContact(c: Context<AppEnv>, email: string) {
  const key = c.get("apiKey");
  requireScope(key, "contacts");
  const row = await c.env.DB.prepare(`${CONTACT_SELECT} WHERE c.email = ?`).bind(email).first<ContactRow>();
  const suppression = await c.env.DB.prepare("SELECT reason, detail, created_at FROM suppressions WHERE email = ?").bind(email).first();
  let history: ReturnType<typeof toSummary>[] = [];
  if (key.scopes.includes("read")) {
    const ids = (await allowedMailboxes(c)).map((m) => m.id);
    if (ids.length) {
      const { results } = await c.env.DB.prepare(
        `SELECT m.*, mb.address AS mailbox_address FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
         WHERE m.mailbox_id IN (${ids.map(() => "?").join(",")}) AND m.folder NOT IN ('trash','spam')
           AND (m.from_addr = ? OR m.to_json LIKE ? ESCAPE '\\' OR m.cc_json LIKE ? ESCAPE '\\')
         ORDER BY m.date DESC LIMIT 20`,
      )
        .bind(...ids, email, `%"${likeEscape(email)}"%`, `%"${likeEscape(email)}"%`)
        .all<MessageRow & { mailbox_address: string }>();
      history = results.map(toSummary);
    }
  }
  if (!row && !history.length) throw new HTTPException(404, { message: `No contact or history for ${email}` });
  return { contact: row ? toContact(row) : null, doNotEmail: suppression ?? null, history };
}

// ---- Do-not-email list ------------------------------------------------------

export async function suppress(c: Context<AppEnv>, email: string, reason: "unsubscribed" | "manual", detail?: string) {
  const key = c.get("apiKey");
  requireScope(key, "contacts");
  await c.env.DB.prepare(
    "INSERT INTO suppressions (email, reason, detail, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET reason = excluded.reason, detail = excluded.detail",
  )
    .bind(email, reason, detail?.slice(0, 500) ?? null, now())
    .run();
  await audit(c, { action: "api.contact_suppressed", targetType: "contact", targetId: email, meta: { reason, apiKey: key.name }, actor: apiActor(c) });
  return { email, doNotEmail: reason };
}

// ---- Reading mail -----------------------------------------------------------

function toSummary(m: MessageRow & { mailbox_address?: string }) {
  return {
    id: m.id,
    threadId: m.thread_id,
    mailbox: m.mailbox_address,
    folder: m.folder,
    direction: m.direction,
    status: m.status,
    from: { email: m.from_addr, name: m.from_name || undefined },
    to: parseJson<Address[]>(m.to_json, []),
    subject: m.subject,
    snippet: m.snippet,
    date: m.date,
    isRead: !!m.is_read,
    hasHtml: !!m.html_key,
    opens: m.open_count,
    clicks: m.click_count,
  };
}

/** Attachment metadata for a set of messages, keyed by message id (inline images excluded). */
async function attachmentsByMessage(c: Context<AppEnv>, messageIds: string[]) {
  const out = new Map<string, { id: string; name: string; size: number; type: string; url: string }[]>();
  if (!messageIds.length) return out;
  const { results } = await c.env.DB.prepare(
    `SELECT id, message_id, filename, content_type, size FROM attachments
     WHERE inline = 0 AND message_id IN (${messageIds.map(() => "?").join(",")}) ORDER BY created_at`,
  )
    .bind(...messageIds)
    .all<{ id: string; message_id: string; filename: string; content_type: string; size: number }>();
  for (const a of results) {
    const list = out.get(a.message_id) ?? [];
    list.push({ id: a.id, name: a.filename, size: a.size, type: a.content_type, url: `/api/v1/attachments/${a.id}` });
    out.set(a.message_id, list);
  }
  return out;
}

/** The HTML body of a message from R2, or null if it has none. */
async function htmlBody(c: Context<AppEnv>, htmlKey: string | null): Promise<string | null> {
  if (!htmlKey) return null;
  const obj = await c.env.FILES.get(htmlKey);
  return obj ? await obj.text() : null;
}

export async function listMessages(
  c: Context<AppEnv>,
  opts: { mailbox?: string; folder?: Folder; query?: string; unreadOnly?: boolean; since?: string; limit?: number },
) {
  requireScope(c.get("apiKey"), "read");
  const boxes = await allowedMailboxes(c);
  const want = opts.mailbox?.toLowerCase();
  const target = want ? boxes.filter((b) => b.id === opts.mailbox || b.address === want) : boxes;
  if (want && !target.length) throw new HTTPException(404, { message: "Mailbox not found or not allowed for this key" });
  if (!target.length) return [];
  const where = [`m.mailbox_id IN (${target.map(() => "?").join(",")})`, "m.folder = ?"];
  const args: unknown[] = [...target.map((b) => b.id), opts.folder ?? "inbox"];
  const q = (opts.query ?? "").trim();
  if (q) {
    const pat = `%${likeEscape(q)}%`;
    where.push(`(m.from_addr LIKE ? ESCAPE '\\' OR m.from_name LIKE ? ESCAPE '\\' OR m.subject LIKE ? ESCAPE '\\' OR m.snippet LIKE ? ESCAPE '\\' OR m.to_json LIKE ? ESCAPE '\\')`);
    args.push(pat, pat, pat, pat, pat);
  }
  if (opts.unreadOnly) where.push("m.is_read = 0");
  if (opts.since) {
    where.push("m.date >= ?");
    args.push(opts.since);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT m.*, mb.address AS mailbox_address FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
     WHERE ${where.join(" AND ")} ORDER BY m.date DESC LIMIT ?`,
  )
    .bind(...args, Math.min(Math.max(opts.limit ?? 25, 1), 100))
    .all<MessageRow & { mailbox_address: string }>();
  return results.map(toSummary);
}

/** Every message in a conversation, oldest first, with plain-text and HTML bodies plus attachments. */
export async function getThread(c: Context<AppEnv>, messageId: string) {
  const key = c.get("apiKey");
  requireScope(key, "read");
  const m = await c.env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(messageId).first<MessageRow>();
  if (!m || !mailboxAllowed(c, m.mailbox_id)) throw new HTTPException(404, { message: "Message not found" });
  const { results } = await c.env.DB.prepare(
    `SELECT m.*, mb.address AS mailbox_address FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
     WHERE m.mailbox_id = ? AND m.thread_id = ? AND m.folder NOT IN ('trash','spam') ORDER BY m.date ASC LIMIT 50`,
  )
    .bind(m.mailbox_id, m.thread_id)
    .all<MessageRow & { mailbox_address: string }>();
  const rows = results.length ? results : [m];
  const [attachments, htmls] = await Promise.all([
    attachmentsByMessage(c, rows.map((r) => r.id)),
    Promise.all(rows.map((r) => htmlBody(c, r.html_key))),
  ]);
  return rows.map((r, i) => ({
    ...toSummary(r),
    cc: parseJson<Address[]>(r.cc_json, []),
    text: r.text_body.slice(0, 8000),
    html: htmls[i],
    attachments: attachments.get(r.id) ?? [],
  }));
}

/** One message in full — summary, recipients, both bodies and its attachments. */
export async function getMessage(c: Context<AppEnv>, messageId: string) {
  requireScope(c.get("apiKey"), "read");
  const m = await c.env.DB.prepare(
    `SELECT m.*, mb.address AS mailbox_address FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id WHERE m.id = ?`,
  )
    .bind(messageId)
    .first<MessageRow & { mailbox_address: string }>();
  if (!m || !mailboxAllowed(c, m.mailbox_id)) throw new HTTPException(404, { message: "Message not found" });
  const [attachments, html] = await Promise.all([attachmentsByMessage(c, [m.id]), htmlBody(c, m.html_key)]);
  return {
    ...toSummary(m),
    cc: parseJson<Address[]>(m.cc_json, []),
    text: m.text_body.slice(0, 8000),
    html,
    attachments: attachments.get(m.id) ?? [],
  };
}

// ---- Message actions --------------------------------------------------------

export const MESSAGE_ACTIONS = ["read", "unread", "archive", "trash", "restore", "star", "unstar"] as const;
export type MessageAction = (typeof MESSAGE_ACTIONS)[number];

/** Read-state needs `read`; anything that moves or flags a message needs `send`. */
const ACTION_SCOPE: Record<MessageAction, ApiScope> = {
  read: "read",
  unread: "read",
  star: "send",
  unstar: "send",
  archive: "send",
  trash: "send",
  restore: "send",
};

interface ActionRow {
  id: string;
  mailbox_id: string;
  thread_id: string;
  folder: string;
  direction: string;
}

/** Mark read/unread, star, archive, trash or restore messages the request may reach. */
export async function messageAction(c: Context<AppEnv>, opts: { ids: string[]; action: MessageAction; thread?: boolean }) {
  requireScope(c.get("apiKey"), ACTION_SCOPE[opts.action]);
  const db = c.env.DB;
  const readState = opts.action === "read" || opts.action === "unread";

  let rows: ActionRow[] = [];
  for (let i = 0; i < opts.ids.length; i += 90) {
    const chunk = opts.ids.slice(i, i + 90);
    const { results } = await db
      .prepare(`SELECT id, mailbox_id, thread_id, folder, direction FROM messages WHERE id IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .all<ActionRow>();
    rows.push(...results);
  }
  // Read state is personal to reading; moving or starring changes the mailbox, so it needs send rights.
  rows = rows.filter((r) => mailboxAllowed(c, r.mailbox_id, readState ? "read" : "write"));

  if (opts.thread) {
    const seen = new Set(rows.map((r) => r.id));
    const extra: ActionRow[] = [];
    for (const konv of new Set(rows.map((r) => `${r.mailbox_id}|${r.thread_id}|${r.folder}`))) {
      const [mb, th, folder] = konv.split("|");
      // Reading a conversation marks all of it; a move only affects the folder in view.
      const sql = `SELECT id, mailbox_id, thread_id, folder, direction FROM messages WHERE mailbox_id = ? AND thread_id = ? AND ${readState ? "folder NOT IN ('trash','spam')" : "folder = ?"}`;
      const stmt = db.prepare(sql);
      const { results } = await (readState ? stmt.bind(mb, th) : stmt.bind(mb, th, folder)).all<ActionRow>();
      for (const r of results) if (!seen.has(r.id)) (seen.add(r.id), extra.push(r));
    }
    rows = rows.concat(extra);
  }
  if (!rows.length) throw new HTTPException(404, { message: "Messages not found" });
  if (!readState && opts.action !== "star" && opts.action !== "unstar" && rows.some((r) => r.folder === "drafts" || r.folder === "scheduled")) {
    throw new HTTPException(400, { message: "Drafts and scheduled messages can't be moved over the API." });
  }

  const t = now();
  const ids = rows.map((r) => r.id);
  const stmts: D1PreparedStatement[] = [];
  const each = (sql: string, ...pre: unknown[]) => {
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      stmts.push(db.prepare(sql.replace("$IDS", chunk.map(() => "?").join(","))).bind(...pre, ...chunk));
    }
  };
  switch (opts.action) {
    case "read":
    case "unread":
      each("UPDATE messages SET is_read = ?, updated_at = ? WHERE id IN ($IDS)", opts.action === "read" ? 1 : 0, t);
      break;
    case "star":
    case "unstar":
      each("UPDATE messages SET is_starred = ?, updated_at = ? WHERE id IN ($IDS)", opts.action === "star" ? 1 : 0, t);
      break;
    case "archive":
      each("UPDATE messages SET folder = 'archive', trashed_at = NULL, folder_before_trash = NULL, updated_at = ? WHERE id IN ($IDS)", t);
      break;
    case "trash":
      each(
        `UPDATE messages SET folder_before_trash = CASE WHEN folder = 'trash' THEN folder_before_trash ELSE folder END,
           folder = 'trash', trashed_at = ?, updated_at = ? WHERE id IN ($IDS)`,
        t,
        t,
      );
      break;
    case "restore":
      each(
        `UPDATE messages SET folder = COALESCE(folder_before_trash, CASE WHEN direction = 'outbound' THEN 'sent' ELSE 'inbox' END),
           folder_before_trash = NULL, trashed_at = NULL, updated_at = ? WHERE id IN ($IDS)`,
        t,
      );
      break;
  }
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  await audit(c, {
    action: `api.message_${opts.action}`,
    targetType: "message",
    meta: { count: ids.length, mailboxes: [...new Set(rows.map((r) => r.mailbox_id))], apiKey: c.get("apiKey").name },
    actor: apiActor(c),
  });
  // `updated` and `count` are the same number; both are returned so callers can use either.
  return { ok: true, updated: ids.length, count: ids.length };
}

export async function sendingStatus(c: Context<AppEnv>) {
  const key = c.get("apiKey");
  const [usage, sup] = await Promise.all([
    quotaUsage(c.env),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM suppressions").first<{ n: number }>(),
  ]);
  return {
    key: { name: key.name, scopes: key.scopes },
    mailboxes: (await allowedMailboxes(c)).map((m) => m.address),
    sentToday: usage.today,
    dailyLimit: usage.dailyLimit || null,
    sentThisMonth: usage.month,
    monthlyLimit: usage.monthlyLimit || null,
    doNotEmailCount: sup?.n ?? 0,
  };
}
