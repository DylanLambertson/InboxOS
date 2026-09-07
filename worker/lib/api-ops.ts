import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Address, Folder } from "@shared/types";
import type { AppEnv } from "../env";
import { keyActor, keyAllowsMailbox, requireScope } from "./apikeys";
import { audit } from "./audit";
import type { MessageRow } from "./messages";
import { likeEscape } from "./search";
import { quotaUsage } from "./send";
import { newId, now, parseJson } from "./util";

/** Operations behind the REST API (/api/v1) and the MCP tools, scoped to the calling API key. */

export async function allowedMailboxes(c: Context<AppEnv>) {
  const key = c.get("apiKey");
  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.address, m.name, m.display_name, m.type,
       (SELECT group_concat(address) FROM mailbox_aliases a WHERE a.mailbox_id = m.id) AS aliases
     FROM mailboxes m WHERE m.is_active = 1 AND m.is_system = 0 ORDER BY m.address`,
  ).all<{ id: string; address: string; name: string; display_name: string; type: string; aliases: string | null }>();
  return results
    .filter((m) => keyAllowsMailbox(key, m.id))
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
  await audit(c, { action: "api.contacts_saved", targetType: "contact", meta: { created, updated: contacts.length - created, apiKey: key.name }, actor: keyActor(key) });
  return { created, updated: contacts.length - created };
}

export async function deleteContact(c: Context<AppEnv>, email: string) {
  const key = c.get("apiKey");
  requireScope(key, "contacts");
  const res = await c.env.DB.prepare("DELETE FROM contacts WHERE email = ?").bind(email).run();
  if (!res.meta.changes) throw new HTTPException(404, { message: `No contact ${email}` });
  await audit(c, { action: "api.contact_deleted", targetType: "contact", targetId: email, meta: { apiKey: key.name }, actor: keyActor(key) });
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
  await audit(c, { action: "api.contact_suppressed", targetType: "contact", targetId: email, meta: { reason, apiKey: key.name }, actor: keyActor(key) });
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
    opens: m.open_count,
    clicks: m.click_count,
  };
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

/** Every message in a conversation, oldest first, with plain-text bodies. */
export async function getThread(c: Context<AppEnv>, messageId: string) {
  const key = c.get("apiKey");
  requireScope(key, "read");
  const m = await c.env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(messageId).first<MessageRow>();
  if (!m || !keyAllowsMailbox(key, m.mailbox_id)) throw new HTTPException(404, { message: "Message not found" });
  const { results } = await c.env.DB.prepare(
    `SELECT m.*, mb.address AS mailbox_address FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
     WHERE m.mailbox_id = ? AND m.thread_id = ? AND m.folder NOT IN ('trash','spam') ORDER BY m.date ASC LIMIT 50`,
  )
    .bind(m.mailbox_id, m.thread_id)
    .all<MessageRow & { mailbox_address: string }>();
  return (results.length ? results : [m]).map((r) => ({
    ...toSummary(r),
    cc: parseJson<Address[]>(r.cc_json, []),
    text: r.text_body.slice(0, 8000),
  }));
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
