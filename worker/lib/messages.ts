import type { Address, AttachmentInfo, Folder, MessageListItem, MessageStatus } from "@shared/types";
import { newId, normalizeSubject, now, parseJson } from "./util";

export interface MessageRow {
  id: string;
  mailbox_id: string;
  thread_id: string;
  direction: "inbound" | "outbound";
  folder: Folder;
  status: MessageStatus;
  from_addr: string;
  from_name: string;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  reply_to_json: string;
  subject: string;
  subject_norm: string;
  snippet: string;
  text_body: string;
  html_key: string | null;
  headers_json: string;
  message_id_header: string | null;
  in_reply_to: string | null;
  references_header: string | null;
  is_read: number;
  is_starred: number;
  has_attachments: number;
  size: number;
  priority: string;
  resend_id: string | null;
  scheduled_at: string | null;
  sent_at: string | null;
  error: string | null;
  open_count: number;
  click_count: number;
  compose_meta: string | null;
  created_by: string | null;
  folder_before_trash: string | null;
  trashed_at: string | null;
  date: string;
  created_at: string;
  updated_at: string;
  // optional joined columns
  thread_count?: number;
  label_ids?: string | null;
  thread_unread?: number;
}

export interface AttachmentRow {
  id: string;
  message_id: string | null;
  mailbox_id: string;
  filename: string;
  content_type: string;
  size: number;
  r2_key: string;
  content_id: string | null;
  inline: number;
  uploaded_by: string | null;
  created_at: string;
}

/** Stored on drafts in `compose_meta`. */
export interface ComposeMeta {
  mode?: "new" | "reply" | "replyAll" | "forward";
  sourceId?: string | null;
  /** Original message quoted below the editable body; appended at send time so its formatting survives. */
  quoteHtml?: string;
  readReceipt?: boolean;
}

export const bodyKey = (mailboxId: string, messageId: string) => `mail/${mailboxId}/${messageId}/body.html`;
export const attachmentKey = (mailboxId: string, attId: string) => `mail/${mailboxId}/att/${attId}`;

export function toListItem(r: MessageRow): MessageListItem {
  return {
    id: r.id,
    threadId: r.thread_id,
    mailboxId: r.mailbox_id,
    folder: r.folder,
    direction: r.direction,
    status: r.status,
    from: { email: r.from_addr, name: r.from_name || undefined },
    to: parseJson<Address[]>(r.to_json, []),
    subject: r.subject,
    snippet: r.snippet,
    isRead: r.thread_unread !== undefined ? r.thread_unread === 0 : !!r.is_read,
    isStarred: !!r.is_starred,
    hasAttachments: !!r.has_attachments,
    labels: r.label_ids ? r.label_ids.split(",") : [],
    date: r.date,
    threadCount: r.thread_count ?? 1,
    scheduledAt: r.scheduled_at,
  };
}

export function toAttachmentInfo(a: AttachmentRow): AttachmentInfo {
  return {
    id: a.id,
    filename: a.filename,
    contentType: a.content_type,
    size: a.size,
    contentId: a.content_id,
    inline: !!a.inline,
  };
}

/** Collect every Message-ID mentioned in In-Reply-To / References. */
export function referencedIds(inReplyTo: string | null, references: string | null): string[] {
  const all = `${inReplyTo ?? ""} ${references ?? ""}`.match(/<[^<>\s]+>/g) ?? [];
  return [...new Set(all)].slice(-20);
}

/**
 * Pick the thread for a new message: header references first, then a
 * same-subject message with an overlapping participant in the last 30 days.
 */
export async function resolveThread(
  db: D1Database,
  mailboxId: string,
  opts: { inReplyTo: string | null; references: string | null; subject: string; participants: string[] },
): Promise<string> {
  const refs = referencedIds(opts.inReplyTo, opts.references);
  if (refs.length) {
    const placeholders = refs.map(() => "?").join(",");
    const hit = await db
      .prepare(`SELECT thread_id FROM messages WHERE mailbox_id = ? AND message_id_header IN (${placeholders}) ORDER BY date DESC LIMIT 1`)
      .bind(mailboxId, ...refs)
      .first<{ thread_id: string }>();
    if (hit) return hit.thread_id;
  }
  const norm = normalizeSubject(opts.subject);
  const isReplyish = /^\s*(re|fw|fwd|aw|sv|wg)\s*:/i.test(opts.subject) || refs.length > 0;
  if (norm && isReplyish && opts.participants.length) {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const { results } = await db
      .prepare(
        `SELECT thread_id, from_addr, to_json, cc_json FROM messages
         WHERE mailbox_id = ? AND subject_norm = ? AND date > ? ORDER BY date DESC LIMIT 25`,
      )
      .bind(mailboxId, norm, since)
      .all<{ thread_id: string; from_addr: string; to_json: string; cc_json: string }>();
    const people = new Set(opts.participants.map((p) => p.toLowerCase()));
    for (const r of results) {
      const theirs = [r.from_addr, ...parseJson<Address[]>(r.to_json, []).map((a) => a.email), ...parseJson<Address[]>(r.cc_json, []).map((a) => a.email)];
      if (theirs.some((e) => people.has(e.toLowerCase()))) return r.thread_id;
    }
  }
  return newId();
}

/** (Re)index a message for full-text search. */
export function ftsStatements(db: D1Database, m: {
  id: string;
  subject: string;
  from: Address;
  to: Address[];
  cc: Address[];
  text: string;
}): D1PreparedStatement[] {
  const addr = (a: Address) => `${a.name ?? ""} ${a.email}`;
  return [
    db.prepare("DELETE FROM messages_fts WHERE message_id = ?").bind(m.id),
    db
      .prepare("INSERT INTO messages_fts (message_id, subject, from_text, to_text, body) VALUES (?, ?, ?, ?, ?)")
      .bind(m.id, m.subject, addr(m.from), [...m.to, ...m.cc].map(addr).join(" "), m.text.slice(0, 50_000)),
  ];
}

/** Record senders/recipients in the org address book for autocomplete. */
export function contactStatements(db: D1Database, addrs: Address[], outbound: boolean): D1PreparedStatement[] {
  const t = now();
  const seen = new Set<string>();
  return addrs
    .filter((a) => a.email && !seen.has(a.email.toLowerCase()) && seen.add(a.email.toLowerCase()))
    .slice(0, 50)
    .map((a) =>
      db
        .prepare(
          `INSERT INTO contacts (id, email, name, times_contacted, last_contacted_at, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?5)
           ON CONFLICT(email) DO UPDATE SET
             name = CASE WHEN contacts.name = '' THEN ?3 ELSE contacts.name END,
             times_contacted = contacts.times_contacted + ?4,
             last_contacted_at = CASE WHEN ?4 > 0 THEN ?5 ELSE contacts.last_contacted_at END,
             updated_at = ?5`,
        )
        .bind(newId(), a.email.toLowerCase(), a.name ?? "", outbound ? 1 : 0, t),
    );
}

/** Delete messages (and their R2 objects) permanently. */
export async function purgeMessages(db: D1Database, files: R2Bucket, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const ph = chunk.map(() => "?").join(",");
    const { results: atts } = await db
      .prepare(`SELECT r2_key FROM attachments WHERE message_id IN (${ph})`)
      .bind(...chunk)
      .all<{ r2_key: string }>();
    const { results: bodies } = await db
      .prepare(`SELECT html_key FROM messages WHERE id IN (${ph}) AND html_key IS NOT NULL`)
      .bind(...chunk)
      .all<{ html_key: string }>();
    const keys = [...atts.map((a) => a.r2_key), ...bodies.map((b) => b.html_key)];
    if (keys.length) await files.delete(keys);
    await db.batch([
      db.prepare(`DELETE FROM messages_fts WHERE message_id IN (${ph})`).bind(...chunk),
      db.prepare(`DELETE FROM attachments WHERE message_id IN (${ph})`).bind(...chunk),
      db.prepare(`DELETE FROM message_labels WHERE message_id IN (${ph})`).bind(...chunk),
      db.prepare(`DELETE FROM messages WHERE id IN (${ph})`).bind(...chunk),
    ]);
  }
}
