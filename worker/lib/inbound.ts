import { UNROUTED_MAILBOX_ID, type Address, type MessageStatus } from "@shared/types";
import type { Env } from "../env";
import { reopenOnInbound } from "./collab";
import { attachmentKey, bodyKey, contactStatements, ftsStatements, resolveThread } from "./messages";
import { isBlocked, type AutoReplyCandidate } from "./mail-rules";
import type { ReceivedNotice } from "./notify";
import { applyRulesOnIngest } from "./rules";
import { getResendApiKey } from "./provider-config";
import { resend, type ReceivedEmail } from "./resend";
import { getPolicy } from "./settings";
import { htmlToText, makeSnippet, newId, normalizeSubject, now, parseAddress, parseAddressList, sanitizeFilename } from "./util";

interface ReceivedEvent {
  email_id: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  received_for?: string[];
}

/** Map recipient addresses to mailbox ids (direct address, alias, then catch-all). */
async function routeRecipients(env: Env, recipients: string[]): Promise<string[]> {
  const addrs = [...new Set(recipients.map((r) => parseAddress(r)?.email).filter((e): e is string => !!e))];
  if (!addrs.length) return [];
  const ph = addrs.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT id FROM mailboxes WHERE is_active = 1 AND is_system = 0 AND address IN (${ph})
     UNION SELECT a.mailbox_id FROM mailbox_aliases a JOIN mailboxes m ON m.id = a.mailbox_id
       WHERE m.is_active = 1 AND m.is_system = 0 AND a.address IN (${ph})`,
  )
    .bind(...addrs, ...addrs)
    .all<{ id: string }>();
  if (results.length) return [...new Set(results.map((r) => r.id))];
  const { catchAllMailboxId } = await getPolicy(env.DB);
  return catchAllMailboxId ? [catchAllMailboxId] : [];
}

function header(h: Record<string, unknown> | null, name: string): string | null {
  if (!h) return null;
  const v = h[name] ?? h[name.toLowerCase()] ?? Object.entries(h).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
  if (v == null) return null;
  return Array.isArray(v) ? v.join(", ") : String(v);
}

async function downloadAttachments(env: Env, email: ReceivedEmail) {
  if (!email.attachments?.length) return [];
  const { data } = await resend.listReceivedAttachments(await getResendApiKey(env), email.id);
  const out: { meta: (typeof data)[number]; bytes: ArrayBuffer }[] = [];
  for (const a of data) {
    const res = await fetch(a.download_url);
    if (!res.ok) {
      console.error("attachment download failed", a.id, res.status);
      continue;
    }
    out.push({ meta: a, bytes: await res.arrayBuffer() });
  }
  return out;
}

export async function ingestReceived(
  env: Env,
  evt: ReceivedEvent,
): Promise<{ stored: number; unrouted: boolean; received: ReceivedNotice[]; autoReplies: AutoReplyCandidate[] }> {
  const email = await resend.getReceived(await getResendApiKey(env), evt.email_id);
  const h = email.headers ?? {};
  const recipients = [
    ...(evt.to ?? email.to ?? []),
    ...(evt.cc ?? email.cc ?? []),
    ...(evt.bcc ?? email.bcc ?? []),
    ...(evt.received_for ?? email.received_for ?? []),
  ];
  let mailboxIds = await routeRecipients(env, recipients);
  const t = now();
  // No mailbox and no catch-all: keep it in the admin-only Unrouted area instead of dropping it.
  const unrouted = mailboxIds.length === 0;
  if (unrouted) mailboxIds = [UNROUTED_MAILBOX_ID];

  const from: Address = parseAddress(header(h, "from") ?? "") ?? parseAddress(email.from) ?? { email: email.from };
  const headerTo = parseAddressList(header(h, "to"));
  const headerCc = parseAddressList(header(h, "cc"));
  const to = headerTo.length ? headerTo : parseAddressList(email.to);
  const cc = headerCc.length ? headerCc : parseAddressList(email.cc ?? []);
  const replyTo = parseAddressList(email.reply_to ?? header(h, "reply-to"));
  const subject = (email.subject ?? "").slice(0, 998);
  const html = email.html ?? null;
  const text = (email.text ?? (html ? htmlToText(html) : "")).slice(0, 100_000);
  const inReplyTo = header(h, "in-reply-to");
  const references = header(h, "references");
  const priorityHeader = (header(h, "x-priority") ?? header(h, "importance") ?? "").toLowerCase();
  const priority = /^[12]|high/.test(priorityHeader) ? "high" : /^[45]|low/.test(priorityHeader) ? "low" : "normal";
  const files = await downloadAttachments(env, email);
  const size = text.length + (html?.length ?? 0) + files.reduce((s, f) => s + f.bytes.byteLength, 0);
  const headersJson = JSON.stringify(Object.fromEntries(Object.entries(h).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)])));

  const lowerHeaders = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(", ") : String(v)]));
  const messageIdHeader = email.message_id ?? header(h, "message-id");

  let stored = 0;
  const received: ReceivedNotice[] = [];
  const autoReplies: AutoReplyCandidate[] = [];
  for (const mailboxId of mailboxIds) {
    const dup = await env.DB.prepare("SELECT id FROM messages WHERE mailbox_id = ? AND resend_id = ?")
      .bind(mailboxId, email.id)
      .first();
    if (dup) continue;

    const id = newId();
    // Blocked senders land in Spam, quietly: no notification, no auto-reply.
    const baseFolder = !unrouted && (await isBlocked(env.DB, mailboxId, from.email)) ? "spam" : "inbox";
    const threadId = await resolveThread(env.DB, mailboxId, {
      inReplyTo,
      references,
      subject,
      participants: [from.email, ...to.map((a) => a.email), ...cc.map((a) => a.email)],
    });
    let htmlKey: string | null = null;
    if (html) {
      htmlKey = bodyKey(mailboxId, id);
      await env.FILES.put(htmlKey, html, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
    }
    const attStmts: D1PreparedStatement[] = [];
    for (const f of files) {
      const attId = newId();
      const key = attachmentKey(mailboxId, attId);
      await env.FILES.put(key, f.bytes, { httpMetadata: { contentType: f.meta.content_type } });
      attStmts.push(
        env.DB.prepare(
          `INSERT INTO attachments (id, message_id, mailbox_id, filename, content_type, size, r2_key, content_id, inline, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          attId,
          id,
          mailboxId,
          sanitizeFilename(f.meta.filename || "attachment"),
          f.meta.content_type || "application/octet-stream",
          f.bytes.byteLength,
          key,
          f.meta.content_id ? f.meta.content_id.replace(/^<|>$/g, "") : null,
          f.meta.content_disposition === "inline" && f.meta.content_id ? 1 : 0,
          t,
        ),
      );
    }
    const visibleAttachments = files.filter((f) => !(f.meta.content_disposition === "inline" && f.meta.content_id)).length;
    // Mailbox rules may file it elsewhere; the final folder decides notices and auto-replies below.
    const ruled = await applyRulesOnIngest(env.DB, {
      mailboxId,
      messageId: id,
      folder: baseFolder,
      message: { from, to, cc, subject, text, hasAttachments: visibleAttachments > 0, size, headers: lowerHeaders },
    });
    const folder = ruled.folder;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO messages (id, mailbox_id, thread_id, direction, folder, status, from_addr, from_name, to_json, cc_json,
           reply_to_json, subject, subject_norm, snippet, text_body, html_key, headers_json, message_id_header, in_reply_to,
           references_header, has_attachments, size, priority, resend_id, date, created_at, updated_at)
         VALUES (?, ?, ?, 'inbound', ?, 'received', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        mailboxId,
        threadId,
        baseFolder,
        from.email,
        from.name ?? "",
        JSON.stringify(to),
        JSON.stringify(cc),
        JSON.stringify(replyTo),
        subject,
        normalizeSubject(subject),
        makeSnippet(text),
        text,
        htmlKey,
        headersJson.slice(0, 60_000),
        messageIdHeader,
        inReplyTo,
        references,
        visibleAttachments > 0 ? 1 : 0,
        size,
        priority,
        email.id,
        t,
        t,
        t,
      ),
      ...attStmts,
      env.DB.prepare(
        "INSERT INTO email_events (id, message_id, resend_id, type, recipient, detail, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, '{}', ?)",
      ).bind(
        newId(),
        id,
        email.id,
        unrouted ? "received.unrouted" : "received",
        (unrouted ? recipients : to.map((a) => a.email)).join(", ").slice(0, 500),
        unrouted ? `No mailbox for ${recipients.join(", ")} (from ${from.email})`.slice(0, 500) : `From ${from.email}`,
        t,
      ),
      ...ftsStatements(env.DB, { id, subject, from, to, cc, text }),
      ...contactStatements(env.DB, [from], false),
      ...ruled.statements,
    ]);
    stored++;
    // A customer reply puts a pending/closed conversation back in front of the team.
    if (!unrouted && folder === "inbox") await reopenOnInbound(env.DB, { mailboxId, threadId });
    // Routed mail is worth telling the panel about; unrouted lands in the admin-only area.
    if (!unrouted && folder === "inbox") {
      if (!ruled.read) received.push({ mailboxId, message: { id, threadId, from, subject, snippet: makeSnippet(text), date: t } });
      const ours = await mailboxAddressSet(env.DB, mailboxId);
      const toAddress = recipients.map((r) => (parseAddress(r)?.email ?? r).toLowerCase()).find((r) => ours.has(r)) ?? "";
      autoReplies.push({ mailboxId, toAddress, from, subject, messageIdHeader, references, headers: lowerHeaders });
    }
  }
  return { stored, unrouted, received, autoReplies };
}

/** Higher rank wins, so late or out-of-order webhooks never downgrade a status. */
const STATUS_RANK: Partial<Record<MessageStatus, number>> = {
  queued: 0,
  sent: 1,
  delivery_delayed: 2,
  delivered: 3,
  bounced: 5,
  complained: 5,
  failed: 5,
  suppressed: 5,
};

const EVENT_STATUS: Record<string, MessageStatus | undefined> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.delivery_delayed": "delivery_delayed",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.failed": "failed",
  "email.suppressed": "suppressed",
};

interface DeliveryEventData {
  email_id: string;
  to?: string[];
  bounce?: { message?: string; type?: string; subType?: string };
  click?: { link?: string; ipAddress?: string; userAgent?: string };
  failed?: { reason?: string };
  [k: string]: unknown;
}

function describe(type: string, d: DeliveryEventData): string | null {
  if (d.bounce) return [d.bounce.type, d.bounce.subType, d.bounce.message].filter(Boolean).join(" · ");
  if (d.click?.link) return `Clicked ${d.click.link}`;
  if (d.failed?.reason) return d.failed.reason;
  if (type === "email.opened") return "Opened";
  return null;
}

export async function recordDeliveryEvent(env: Env, type: string, data: DeliveryEventData, raw: string): Promise<void> {
  const t = now();
  const msg = await env.DB.prepare("SELECT id, status FROM messages WHERE resend_id = ? AND direction = 'outbound'")
    .bind(data.email_id)
    .first<{ id: string; status: MessageStatus }>();
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      "INSERT INTO email_events (id, message_id, resend_id, type, recipient, detail, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      newId(),
      msg?.id ?? null,
      data.email_id,
      type.replace(/^email\./, ""),
      (data.to ?? []).join(", ").slice(0, 500) || null,
      describe(type, data)?.slice(0, 1000) ?? null,
      raw.slice(0, 20_000),
      t,
    ),
  ];
  if (msg) {
    const next = EVENT_STATUS[type];
    if (next && (STATUS_RANK[next] ?? 0) >= (STATUS_RANK[msg.status] ?? 0) && next !== msg.status) {
      stmts.push(env.DB.prepare("UPDATE messages SET status = ?, updated_at = ? WHERE id = ?").bind(next, t, msg.id));
    }
    if (type === "email.opened") stmts.push(env.DB.prepare("UPDATE messages SET open_count = open_count + 1 WHERE id = ?").bind(msg.id));
    if (type === "email.clicked") stmts.push(env.DB.prepare("UPDATE messages SET click_count = click_count + 1 WHERE id = ?").bind(msg.id));
  }
  // Never mail a hard-bounced or complaining address again; it hurts the domain's reputation.
  const hardBounce = type === "email.bounced" && (data.bounce?.type ?? "Permanent") === "Permanent";
  if (hardBounce || type === "email.complained") {
    for (const email of (data.to ?? []).slice(0, 50)) {
      stmts.push(
        env.DB.prepare("INSERT OR IGNORE INTO suppressions (email, reason, detail, created_at) VALUES (?, ?, ?, ?)").bind(
          email.toLowerCase(),
          hardBounce ? "bounced" : "complained",
          describe(type, data)?.slice(0, 500) ?? null,
          t,
        ),
      );
    }
  }
  await env.DB.batch(stmts);
}

/** A mailbox's own address and aliases, lowercased. */
async function mailboxAddressSet(db: D1Database, mailboxId: string): Promise<Set<string>> {
  const { results } = await db
    .prepare("SELECT address FROM mailboxes WHERE id = ?1 UNION SELECT address FROM mailbox_aliases WHERE mailbox_id = ?1")
    .bind(mailboxId)
    .all<{ address: string }>();
  return new Set(results.map((r) => r.address.toLowerCase()));
}
