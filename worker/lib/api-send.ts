import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Address } from "@shared/types";
import type { AppEnv } from "../env";
import { allowedMailboxes } from "./api-ops";
import { keyActor, keyAllowsMailbox, requireScope } from "./apikeys";
import { audit } from "./audit";
import { bodyKey, ftsStatements, purgeMessages, type ComposeMeta, type MessageRow } from "./messages";
import { prefixSubject } from "./quote";
import { rateLimit } from "./ratelimit";
import { deliverMessage, SendError } from "./send";
import { unsubscribeFooter, unsubscribeHeaders, unsubscribeUrl } from "./unsubscribe";
import { escapeHtml, htmlToText, makeSnippet, newId, normalizeSubject, now, parseAddress, parseJson } from "./util";

export interface ApiSendInput {
  /** "Name <address>" or a bare address of a mailbox (or alias) the key may use. */
  from?: string;
  mailboxId?: string;
  to: Address[];
  cc?: Address[];
  bcc?: Address[];
  replyTo?: Address[];
  subject?: string;
  html?: string;
  text?: string;
  /** Reply inside an existing conversation (threads it and defaults subject/recipients). */
  replyToMessageId?: string;
  scheduledAt?: string | null;
  /** "draft" leaves it in the mailbox's Drafts for a person to review and send. */
  mode: "send" | "draft";
  /** Cold/marketing mail: one recipient, unsubscribe link + headers, blocked for anyone suppressed. */
  outreach?: boolean;
  /** Append the mailbox signature. */
  signature?: boolean;
}

export interface ApiSendResult {
  id: string;
  message_id: string | null;
  provider_id: string | null;
  status: string;
  thread_id: string;
  mailbox: string;
  scheduled_at: string | null;
}

interface MailboxRow {
  id: string;
  address: string;
  display_name: string;
  signature_html: string;
}

async function mailboxById(db: D1Database, id: string) {
  return db
    .prepare("SELECT id, address, display_name, signature_html FROM mailboxes WHERE id = ? AND is_active = 1 AND is_system = 0")
    .bind(id)
    .first<MailboxRow>();
}

/** Resolve which mailbox sends, and from which of its addresses. */
async function resolveSender(c: Context<AppEnv>, input: ApiSendInput, fallbackMailboxId: string | null) {
  const db = c.env.DB;
  const key = c.get("apiKey");
  const from = input.from ? parseAddress(input.from) : null;
  if (input.from && !from) throw new HTTPException(400, { message: `"${input.from}" isn't a valid from address` });

  let mailbox: MailboxRow | null = null;
  let address: string | null = null;
  if (from) {
    const alias = await db.prepare("SELECT mailbox_id FROM mailbox_aliases WHERE address = ?").bind(from.email).first<{ mailbox_id: string }>();
    const direct = await db.prepare("SELECT id FROM mailboxes WHERE address = ?").bind(from.email).first<{ id: string }>();
    const id = direct?.id ?? alias?.mailbox_id;
    mailbox = id ? await mailboxById(db, id) : null;
    if (!mailbox) throw new HTTPException(422, { message: `No active mailbox sends as ${from.email}. Create it (or add it as an alias) in Admin → Mailboxes.` });
    address = from.email;
  } else {
    let id = input.mailboxId ?? fallbackMailboxId;
    if (!id) {
      const choices = await allowedMailboxes(c);
      if (choices.length !== 1) {
        throw new HTTPException(400, { message: `Say which mailbox to send from: ${choices.map((m) => m.address).join(", ") || "none available to this key"}.` });
      }
      id = choices[0].id;
    }
    mailbox = await mailboxById(db, id);
    if (!mailbox) throw new HTTPException(404, { message: "Mailbox not found" });
    address = mailbox.address;
  }
  if (input.mailboxId && input.mailboxId !== mailbox.id) throw new HTTPException(400, { message: "The from address belongs to a different mailbox" });
  if (!keyAllowsMailbox(key, mailbox.id)) throw new HTTPException(403, { message: `This API key can't send from ${mailbox.address}` });
  return { mailbox, address, fromName: from?.name };
}

/** Plain text → simple paragraphs with clickable links. */
export function plainToHtml(text: string): string {
  const linkify = (s: string) => s.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (u) => `<a href="${u}">${u}</a>`);
  return text
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${linkify(escapeHtml(p)).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

const isDocument = (html: string) => /<!doctype|<html[\s>]/i.test(html);

function insertBeforeBodyEnd(doc: string, fragment: string): string {
  const i = doc.search(/<\/body>/i);
  return i === -1 ? doc + fragment : doc.slice(0, i) + fragment + doc.slice(i);
}

/** Create a message from an API request, then send, schedule or leave it as a draft. */
export async function apiSend(c: Context<AppEnv>, input: ApiSendInput): Promise<ApiSendResult> {
  const env = c.env;
  const db = env.DB;
  const key = c.get("apiKey");
  requireScope(key, "send");
  if (input.mode === "send" && !input.scheduledAt && !(await rateLimit(db, `api-send:${key.id}`, 30, 60))) {
    throw new HTTPException(429, { message: "This key is sending too fast (30 per minute). Wait a minute and retry." });
  }

  // Replies thread under the original and default to its mailbox, subject and sender.
  let src: MessageRow | null = null;
  if (input.replyToMessageId) {
    src = await db.prepare("SELECT * FROM messages WHERE id = ?").bind(input.replyToMessageId).first<MessageRow>();
    if (!src || !keyAllowsMailbox(key, src.mailbox_id)) throw new HTTPException(404, { message: "Message to reply to not found" });
  }
  const { mailbox, address, fromName } = await resolveSender(c, input, src?.mailbox_id ?? null);
  if (src && src.mailbox_id !== mailbox.id) throw new HTTPException(400, { message: "Reply from the mailbox that holds the conversation" });

  let to = input.to;
  if (!to.length && src) {
    const srcReplyTo = parseJson<Address[]>(src.reply_to_json, []);
    to = src.direction === "outbound" ? parseJson<Address[]>(src.to_json, []) : srcReplyTo.length ? srcReplyTo : [{ email: src.from_addr, name: src.from_name || undefined }];
  }
  const cc = input.cc ?? [];
  const bcc = input.bcc ?? [];
  const everyone = [...to, ...cc, ...bcc];
  if (!everyone.length) throw new HTTPException(400, { message: "Add at least one recipient" });
  if (everyone.length > 50) throw new HTTPException(400, { message: "A message can have at most 50 recipients" });
  if (input.outreach && (to.length !== 1 || cc.length || bcc.length)) {
    throw new HTTPException(400, { message: "Outreach goes to one person per email, so each unsubscribe link is theirs. Send separate emails." });
  }

  const emails = everyone.map((a) => a.email.toLowerCase());
  const { results: blocked } = await db
    .prepare(`SELECT email, reason FROM suppressions WHERE email IN (${emails.map(() => "?").join(",")})`)
    .bind(...emails)
    .all<{ email: string; reason: string }>();
  const stop = blocked.filter((b) => input.outreach || b.reason === "bounced" || b.reason === "complained");
  if (stop.length) {
    throw new HTTPException(422, { message: `Not sent: ${stop.map((b) => `${b.email} (${b.reason})`).join(", ")} is on the do-not-email list.` });
  }

  const subject = (input.subject ?? (src ? prefixSubject(src.subject, "Re") : "")).trim();
  if (!subject) throw new HTTPException(400, { message: "Add a subject" });
  if (!input.html && !input.text) throw new HTTPException(400, { message: "Add a body (html or text)" });

  const rawHtml = !!input.html && isDocument(input.html);
  let html = input.html ?? plainToHtml(input.text!);
  let text = input.text ?? "";
  const extra: string[] = [];
  const sig = input.signature && !rawHtml ? mailbox.signature_html.trim() : "";
  if (sig) {
    extra.push(`<div style="margin-top:16px">${sig}</div>`);
    if (text) text += `\n\n${htmlToText(sig)}`;
  }
  let headers: Record<string, string> | undefined;
  if (input.outreach) {
    const url = await unsubscribeUrl(env.APP_URL, env.SESSION_SECRET, to[0].email);
    const footer = unsubscribeFooter(url);
    extra.push(footer.html);
    if (text) text += footer.text;
    headers = unsubscribeHeaders(url);
  }
  html = rawHtml ? insertBeforeBodyEnd(html, extra.join("")) : html + extra.join("");

  const id = newId();
  const t = now();
  const refs = src ? [src.references_header, src.message_id_header].filter(Boolean).join(" ").split(/\s+/).filter(Boolean).slice(-10).join(" ") : "";
  const meta: ComposeMeta = { mode: src ? "reply" : "new", sourceId: src?.id ?? null, api: { fromName, rawHtml, text: text || undefined, headers, keyId: key.id } };
  const bodyText = text || htmlToText(html);
  const k = bodyKey(mailbox.id, id);
  await env.FILES.put(k, html, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
  await db.batch([
    db
      .prepare(
        `INSERT INTO messages (id, mailbox_id, thread_id, direction, folder, status, from_addr, to_json, cc_json, bcc_json, reply_to_json,
           subject, subject_norm, snippet, text_body, html_key, in_reply_to, references_header, priority, compose_meta, is_read,
           has_attachments, created_by, date, created_at, updated_at)
         VALUES (?, ?, ?, 'outbound', 'drafts', 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'normal', ?, 1, 0, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        mailbox.id,
        src?.thread_id ?? newId(),
        address,
        JSON.stringify(to),
        JSON.stringify(cc),
        JSON.stringify(bcc),
        JSON.stringify(input.replyTo ?? []),
        subject,
        normalizeSubject(subject),
        makeSnippet(bodyText),
        bodyText.slice(0, 100_000),
        k,
        src?.message_id_header ?? null,
        refs || null,
        JSON.stringify(meta),
        key.createdBy,
        t,
        t,
        t,
      ),
    ...ftsStatements(db, { id, subject, from: { email: address }, to, cc, text: bodyText }),
  ]);

  const result = (m: MessageRow): ApiSendResult => ({
    id: m.id,
    message_id: m.message_id_header,
    provider_id: m.resend_id,
    status: m.status,
    thread_id: m.thread_id,
    mailbox: mailbox.address,
    scheduled_at: m.scheduled_at,
  });
  const auditMeta = { mailboxId: mailbox.id, recipients: everyone.length, outreach: !!input.outreach, apiKey: key.name };
  const actor = keyActor(key);

  if (input.mode === "draft") {
    await audit(c, { action: "api.draft_created", targetType: "message", targetId: id, meta: auditMeta, actor });
    return result((await db.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first<MessageRow>())!);
  }

  if (input.scheduledAt) {
    const at = Date.parse(input.scheduledAt);
    if (!(at > Date.now() + 30_000) || at > Date.now() + 365 * 86_400_000) {
      await purgeMessages(db, env.FILES, [id]);
      throw new HTTPException(400, { message: "Schedule between 1 minute and 1 year from now (ISO 8601 with timezone)." });
    }
    const iso = new Date(at).toISOString();
    await db.prepare("UPDATE messages SET status = 'scheduled', folder = 'scheduled', scheduled_at = ? WHERE id = ?").bind(iso, id).run();
    await audit(c, { action: "api.message_scheduled", targetType: "message", targetId: id, meta: { ...auditMeta, scheduledAt: iso }, actor });
    return result((await db.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first<MessageRow>())!);
  }

  await db.prepare("UPDATE messages SET status = 'queued' WHERE id = ?").bind(id).run();
  try {
    const sent = await deliverMessage(env, id);
    await audit(c, { action: "api.message_sent", targetType: "message", targetId: id, meta: auditMeta, actor });
    return result(sent);
  } catch (err) {
    // Nothing went out: remove the message so the caller can simply retry.
    await purgeMessages(db, env.FILES, [id]);
    if (err instanceof SendError) throw new HTTPException(err.status as 400, { message: err.message });
    throw err;
  }
}
