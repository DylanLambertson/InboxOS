import type { Address } from "@shared/types";
import type { Env } from "../env";
import { contactStatements, ftsStatements, type AttachmentRow, type ComposeMeta, type MessageRow } from "./messages";
import { applyOutboundPolicy, PolicyBlockedError } from "./outbound";
import { resend, ResendError, type ResendAttachment } from "./resend";
import { getBrand, getPolicy } from "./settings";
import { b64encode, domainOf, formatAddress, htmlToText, makeSnippet, newId, now, parseJson } from "./util";

export interface QuotaUsage {
  /** All emails sent through the provider, including system emails. */
  today: number;
  month: number;
  /** The system-email share of the totals above (invites, resets, alerts). */
  systemToday: number;
  systemMonth: number;
  dailyLimit: number;
  monthlyLimit: number;
}

/** Emails sent through the provider in the current UTC day/month — team mail plus system emails, as Resend counts them. */
export async function quotaUsage(env: Env): Promise<QuotaUsage> {
  const policy = await getPolicy(env.DB);
  const d = new Date();
  const dayStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
  const monthStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
  const row = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN sent_at >= ?1 THEN 1 ELSE 0 END) AS today,
       COUNT(*) AS month
     FROM messages WHERE direction = 'outbound' AND sent_at >= ?2 AND status NOT IN ('failed','canceled','draft')`,
  )
    .bind(dayStart, monthStart)
    .first<{ today: number | null; month: number }>();
  const sys = await env.DB.prepare(
    `SELECT SUM(CASE WHEN created_at >= ?1 THEN 1 ELSE 0 END) AS today, COUNT(*) AS month
     FROM email_events WHERE type = 'system' AND created_at >= ?2`,
  )
    .bind(dayStart, monthStart)
    .first<{ today: number | null; month: number }>();
  const systemToday = sys?.today ?? 0;
  const systemMonth = sys?.month ?? 0;
  return {
    today: (row?.today ?? 0) + systemToday,
    month: (row?.month ?? 0) + systemMonth,
    systemToday,
    systemMonth,
    dailyLimit: policy.dailySendLimit,
    monthlyLimit: policy.monthlySendLimit,
  };
}

export class SendError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

/** Wraps editor HTML in a minimal, client-friendly email document. */
function wrapHtml(inner: string, fontFamily: string): string {
  const cleaned = inner.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/\son\w+="[^"]*"/gi, "");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0"><div style="font-family:${fontFamily.replace(/"/g, "'")};font-size:14px;line-height:1.55;color:#111827">${cleaned}</div></body></html>`;
}

/**
 * Deliver a stored draft/scheduled message through Resend and move it to Sent.
 * Throws SendError on validation/quota problems; provider failures mark the message failed.
 */
export async function deliverMessage(env: Env, messageId: string): Promise<MessageRow> {
  const msg = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(messageId).first<MessageRow>();
  if (!msg) throw new SendError("Message not found", 404);
  if (!["draft", "scheduled", "queued", "failed"].includes(msg.status)) {
    throw new SendError("This message has already been sent", 409);
  }
  const mailbox = await env.DB.prepare("SELECT address, display_name, is_active FROM mailboxes WHERE id = ?")
    .bind(msg.mailbox_id)
    .first<{ address: string; display_name: string; is_active: number }>();
  if (!mailbox?.is_active) throw new SendError("Mailbox is disabled", 403);

  const to = parseJson<Address[]>(msg.to_json, []);
  const cc = parseJson<Address[]>(msg.cc_json, []);
  const bcc = parseJson<Address[]>(msg.bcc_json, []);
  const replyTo = parseJson<Address[]>(msg.reply_to_json, []);
  const total = to.length + cc.length + bcc.length;
  if (!to.length && !cc.length && !bcc.length) throw new SendError("Add at least one recipient");
  if (total > 50) throw new SendError("A message can have at most 50 recipients");

  // Never deliver to a hard-bounced or complained address: it's proven undeliverable and
  // keeps hurting the domain's reputation. The API path blocks these up front; this is the
  // backstop every send (web, scheduled, API) funnels through. System mail uses a separate
  // path and is deliberately exempt, so invites and password resets still go out.
  const recipientEmails = [...to, ...cc, ...bcc].map((a) => a.email.toLowerCase());
  const { results: blocked } = await env.DB.prepare(
    `SELECT email, reason FROM suppressions WHERE reason IN ('bounced','complained') AND email IN (${recipientEmails.map(() => "?").join(",")})`,
  )
    .bind(...recipientEmails)
    .all<{ email: string; reason: string }>();
  if (blocked.length) {
    throw new SendError(`Not sent: ${blocked.map((b) => `${b.email} (${b.reason})`).join(", ")} is on the do-not-email list.`, 422);
  }

  const [brand, policy, usage] = await Promise.all([getBrand(env.DB), getPolicy(env.DB), quotaUsage(env)]);
  if (policy.dailySendLimit > 0 && usage.today >= policy.dailySendLimit) {
    throw new SendError(`Daily sending limit reached (${policy.dailySendLimit}). Try again tomorrow or raise the limit in Admin → Settings.`, 429);
  }
  if (policy.monthlySendLimit > 0 && usage.month >= policy.monthlySendLimit) {
    throw new SendError(`Monthly sending limit reached (${policy.monthlySendLimit}).`, 429);
  }

  const { results: atts } = await env.DB.prepare("SELECT * FROM attachments WHERE message_id = ?")
    .bind(msg.id)
    .all<AttachmentRow>();
  const totalBytes = atts.reduce((s, a) => s + a.size, 0);
  if (totalBytes > policy.maxAttachmentMb * 1024 * 1024) {
    throw new SendError(`Attachments exceed ${policy.maxAttachmentMb} MB`);
  }
  const meta = parseJson<ComposeMeta>(msg.compose_meta, {});
  let body = "";
  if (msg.html_key) {
    const obj = await env.FILES.get(msg.html_key);
    body = obj ? await obj.text() : "";
  }
  const fromAddress = msg.from_addr || mailbox.address;
  // Outbound policy runs here so no send path (web, scheduled, API, MCP) can skip
  // the DLP re-check, the enforced company signature or the legal disclaimer.
  const outbound = await applyOutboundPolicy(env.DB, brand, {
    messageId: msg.id,
    userId: msg.created_by,
    mailboxId: msg.mailbox_id,
    fromAddress,
    subject: msg.subject,
    bodyHtml: body,
    quoteHtml: meta.quoteHtml ?? "",
    apiText: meta.api?.text,
    rawHtml: !!meta.api?.rawHtml,
    fromApi: !!meta.api,
    recipients: [...to, ...cc, ...bcc],
    filenames: atts.map((a) => a.filename),
  }).catch((err) => {
    throw err instanceof PolicyBlockedError ? new SendError(err.message, 422) : err;
  });
  let html = outbound.html;
  // Images pasted into the editor point at our API; turn them into cid: references.
  for (const a of atts) {
    if (!a.inline || !a.content_id) continue;
    const re = new RegExp(`(?:https?://[^"'\\s>]*)?/api/attachments/${a.id}(?:/raw)?(?:\\?[^"'\\s>]*)?`, "g");
    html = html.replace(re, `cid:${a.content_id}`);
  }
  const attachments: ResendAttachment[] = [];
  for (const a of atts) {
    // Skip inline images that are no longer referenced in the body.
    if (a.inline && a.content_id && !html.includes(`cid:${a.content_id}`)) continue;
    const obj = await env.FILES.get(a.r2_key);
    if (!obj) throw new SendError(`Attachment "${a.filename}" is missing; remove it and try again`);
    attachments.push({
      filename: a.filename,
      content: b64encode(new Uint8Array(await obj.arrayBuffer())),
      content_type: a.content_type,
      ...(a.inline && a.content_id ? { content_id: a.content_id } : {}),
    });
  }

  const text = outbound.text || htmlToText(html) || msg.text_body;
  const messageIdHeader = msg.message_id_header ?? `<${newId(12)}.${Date.now()}@${domainOf(fromAddress)}>`;

  const headers: Record<string, string> = { ...meta.api?.headers, "Message-ID": messageIdHeader };
  if (msg.in_reply_to) headers["In-Reply-To"] = msg.in_reply_to;
  if (msg.references_header) headers["References"] = msg.references_header;
  if (msg.priority === "high") Object.assign(headers, { "X-Priority": "1", Importance: "high" });
  if (msg.priority === "low") Object.assign(headers, { "X-Priority": "5", Importance: "low" });
  if (meta.readReceipt) headers["Disposition-Notification-To"] = fromAddress;

  const t = now();
  try {
    const res = await resend.send(
      env.RESEND_API_KEY,
      {
        from: formatAddress({ email: fromAddress, name: meta.api?.fromName || mailbox.display_name || brand.defaultFromName }),
        to: to.map(formatAddress),
        ...(cc.length ? { cc: cc.map(formatAddress) } : {}),
        ...(bcc.length ? { bcc: bcc.map(formatAddress) } : {}),
        ...(replyTo.length ? { reply_to: replyTo.map(formatAddress) } : {}),
        subject: msg.subject || "(no subject)",
        html: meta.api?.rawHtml ? html : wrapHtml(html, brand.fontFamily),
        text,
        headers,
        ...(attachments.length ? { attachments } : {}),
        tags: [
          { name: "mailbox", value: msg.mailbox_id.replace(/[^A-Za-z0-9_-]/g, "_") },
          { name: "message", value: msg.id.replace(/[^A-Za-z0-9_-]/g, "_") },
        ],
      },
      `send-${msg.id}-${msg.updated_at}`,
    );
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE messages SET status = 'sent', folder = 'sent', resend_id = ?, sent_at = ?, date = ?,
           message_id_header = ?, text_body = ?, snippet = ?, error = NULL, is_read = 1, updated_at = ?
         WHERE id = ?`,
      ).bind(res.id, t, t, messageIdHeader, text.slice(0, 100_000), makeSnippet(text), t, msg.id),
      env.DB.prepare(
        "INSERT INTO email_events (id, message_id, resend_id, type, detail, payload, created_at) VALUES (?, ?, ?, 'accepted', ?, '{}', ?)",
      ).bind(newId(), msg.id, res.id, `Accepted by provider for ${total} recipient(s)`, t),
      ...ftsStatements(env.DB, { id: msg.id, subject: msg.subject, from: { email: fromAddress, name: mailbox.display_name }, to, cc, text }),
      ...contactStatements(env.DB, [...to, ...cc, ...bcc], true),
    ]);
  } catch (err) {
    const message = err instanceof ResendError ? err.message : "Unexpected error while sending";
    console.error("send failed", msg.id, err);
    await env.DB.batch([
      env.DB.prepare("UPDATE messages SET status = 'failed', folder = 'drafts', error = ?, updated_at = ? WHERE id = ?").bind(message, t, msg.id),
      env.DB.prepare(
        "INSERT INTO email_events (id, message_id, type, detail, payload, created_at) VALUES (?, ?, 'failed', ?, '{}', ?)",
      ).bind(newId(), msg.id, message, t),
    ]);
    throw new SendError(`Sending failed: ${message}`, 502);
  }
  return (await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(msg.id).first<MessageRow>())!;
}

/** Cron: send scheduled messages whose time has come. */
export async function dispatchScheduled(env: Env): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT id FROM messages WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 25",
  )
    .bind(now())
    .all<{ id: string }>();
  let sent = 0;
  for (const { id } of results) {
    // Claim the row so overlapping cron runs don't double-send.
    const claim = await env.DB.prepare("UPDATE messages SET status = 'queued', updated_at = ? WHERE id = ? AND status = 'scheduled'")
      .bind(now(), id)
      .run();
    if (!claim.meta.changes) continue;
    try {
      await deliverMessage(env, id);
      sent++;
    } catch (err) {
      console.error("scheduled send failed", id, err);
      if (err instanceof SendError && err.status === 429) {
        // Quota hit: leave it scheduled for the next window.
        await env.DB.prepare("UPDATE messages SET status = 'scheduled', error = ? WHERE id = ?").bind(err.message, id).run();
      } else if (err instanceof SendError && err.status !== 502) {
        // Validation problem (provider failures are already recorded by deliverMessage).
        await env.DB.prepare("UPDATE messages SET status = 'failed', folder = 'drafts', error = ?, updated_at = ? WHERE id = ?")
          .bind(err.message, now(), id)
          .run();
      }
    }
  }
  return sent;
}
