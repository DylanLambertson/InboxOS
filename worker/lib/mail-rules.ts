import { mailDomains } from "@shared/brand";
import type { Address } from "@shared/types";
import type { Env } from "../env";
import { getResendApiKey } from "./provider-config";
import { resend } from "./resend";
import { quotaUsage } from "./send";
import { getBrand, getPolicy } from "./settings";
import { logSystemEmail } from "./system-mail";
import { domainOf, escapeHtml, formatAddress, now, parseJson } from "./util";

/** Per-mailbox rules applied to incoming mail: blocked senders and the vacation auto-reply. */

export interface AutoReply {
  enabled: boolean;
  subject: string;
  /** Plain text; line breaks are kept. */
  message: string;
  /** ISO timestamps; null = no limit on that side. */
  startsAt: string | null;
  endsAt: string | null;
}

export const DEFAULT_AUTOREPLY: AutoReply = { enabled: false, subject: "", message: "", startsAt: null, endsAt: null };

export const parseAutoReply = (json: string | null | undefined): AutoReply => ({ ...DEFAULT_AUTOREPLY, ...parseJson<Partial<AutoReply>>(json ?? null, {}) });

/** Whether an auto-reply is switched on and inside its date range right now. */
export function autoReplyActive(a: AutoReply, at = now()): boolean {
  return a.enabled && !!a.message.trim() && (!a.startsAt || a.startsAt <= at) && (!a.endsAt || a.endsAt > at);
}

/** Normalize a block pattern: a full address, or "@domain" for everything from a domain. */
export function normalizeBlockPattern(input: string): string | null {
  const v = input.trim().toLowerCase();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return v;
  const domain = v.replace(/^@/, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? `@${domain}` : null;
}

export async function isBlocked(db: D1Database, mailboxId: string, sender: string): Promise<boolean> {
  const email = sender.toLowerCase();
  const row = await db
    .prepare("SELECT 1 FROM blocked_senders WHERE mailbox_id = ? AND pattern IN (?, ?)")
    .bind(mailboxId, email, `@${domainOf(email)}`)
    .first();
  return !!row;
}

/** Days before the same sender gets another auto-reply. */
const REPLY_EVERY_DAYS = 4;
const MACHINE_SENDER = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?|notifications?|alerts?|info-noreply)([+._-]|@)/i;

/**
 * Whether a message must not get an auto-reply: mail from machines, lists and bulk
 * senders (RFC 3834), so we never answer newsletters or loop with another responder.
 */
export function skipAutoReply(from: string, headers: Record<string, string>): boolean {
  const h = (name: string) => (headers[name] ?? headers[name.toLowerCase()] ?? "").toString().toLowerCase();
  if (!from || MACHINE_SENDER.test(from)) return true;
  const auto = h("auto-submitted");
  if (auto && auto !== "no") return true;
  if (/bulk|list|junk/.test(h("precedence"))) return true;
  if (h("list-id") || h("list-unsubscribe") || h("feedback-id")) return true;
  if (/\b(all|oof|autoreply)\b/.test(h("x-auto-response-suppress"))) return true;
  return false;
}

export interface AutoReplyCandidate {
  mailboxId: string;
  /** Our address the message was sent to (an alias counts), used as the From. */
  toAddress: string;
  from: Address;
  subject: string;
  messageIdHeader: string | null;
  references: string | null;
  headers: Record<string, string>;
}

/** Send vacation auto-replies for freshly received mail. Never throws. */
export async function sendAutoReplies(env: Env, candidates: AutoReplyCandidate[]): Promise<void> {
  for (const c of candidates) {
    try {
      await sendOne(env, c);
    } catch (err) {
      console.error("auto-reply failed", c.mailboxId, err);
    }
  }
}

async function sendOne(env: Env, c: AutoReplyCandidate) {
  const sender = c.from.email.toLowerCase();
  if (skipAutoReply(sender, c.headers)) return;
  const brand = await getBrand(env.DB);
  // Never answer our own domains: colleagues know, and two of our mailboxes could ping-pong.
  if (mailDomains(brand).includes(domainOf(sender))) return;

  const mb = await env.DB.prepare("SELECT address, display_name, autoreply_json, is_active FROM mailboxes WHERE id = ?")
    .bind(c.mailboxId)
    .first<{ address: string; display_name: string; autoreply_json: string | null; is_active: number }>();
  if (!mb?.is_active) return;
  const rule = parseAutoReply(mb.autoreply_json);
  if (!autoReplyActive(rule)) return;
  if (await env.DB.prepare("SELECT 1 FROM suppressions WHERE email = ?").bind(sender).first()) return;

  const [policy, usage] = await Promise.all([getPolicy(env.DB), quotaUsage(env)]);
  if ((policy.dailySendLimit && usage.today >= policy.dailySendLimit) || (policy.monthlySendLimit && usage.month >= policy.monthlySendLimit)) return;

  // Claim the slot atomically: only one reply per sender per window, even with concurrent webhooks.
  const t = now();
  const cutoff = new Date(Date.now() - REPLY_EVERY_DAYS * 86_400_000).toISOString();
  const claimed = await env.DB.prepare(
    `INSERT INTO autoreply_log (mailbox_id, sender, sent_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(mailbox_id, sender) DO UPDATE SET sent_at = ?3 WHERE sent_at < ?4
     RETURNING sent_at`,
  )
    .bind(c.mailboxId, sender, t, cutoff)
    .first();
  if (!claimed) return;

  const subject = (rule.subject.trim() || `Re: ${c.subject || "your message"}`).slice(0, 998);
  const text = rule.message.trim();
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:#111827">${escapeHtml(text).replace(/\n/g, "<br>")}</div>`;
  const headers: Record<string, string> = {
    "Auto-Submitted": "auto-replied",
    "X-Auto-Response-Suppress": "All",
    Precedence: "auto_reply",
  };
  if (c.messageIdHeader) {
    headers["In-Reply-To"] = c.messageIdHeader;
    headers["References"] = [c.references, c.messageIdHeader].filter(Boolean).join(" ").slice(-900);
  }
  try {
    const res = await resend.send(
      await getResendApiKey(env),
      {
        from: formatAddress({ email: c.toAddress || mb.address, name: mb.display_name || brand.defaultFromName }),
        to: [sender],
        subject,
        html,
        text,
        headers,
        tags: [{ name: "category", value: "autoreply" }],
      },
      `autoreply-${c.mailboxId}-${sender}-${t.slice(0, 10)}`.replace(/[^A-Za-z0-9_.@-]/g, "_").slice(0, 250),
    );
    await logSystemEmail(env, { resendId: res.id, to: sender, subject, category: "autoreply" });
  } catch (err) {
    // Free the slot so the next message from this sender can try again.
    await env.DB.prepare("DELETE FROM autoreply_log WHERE mailbox_id = ? AND sender = ? AND sent_at = ?").bind(c.mailboxId, sender, t).run();
    await logSystemEmail(env, { resendId: null, to: sender, subject, category: "autoreply", error: err instanceof Error ? err.message : "Unknown error" });
  }
}
