import { mailDomains, type Brand } from "@shared/brand";
import { DIGEST_HOURS, type DigestHours } from "@shared/types";
import type { Env } from "../env";
import { templates } from "./email-templates";
import { quotaUsage } from "./send";
import { featureEnabled } from "./features";
import { getBrand, getPolicy } from "./settings";
import { sendSystemEmail } from "./system-mail";
import { digestOffUrl, unsubscribeHeaders } from "./unsubscribe";
import { domainOf, newId } from "./util";

/**
 * Unread-mail digests: every few hours, a short email to a person's verified
 * personal address listing mail that arrived in their mailboxes and is still unread.
 *
 * There's no queue: each digest is computed from `messages` for the window since
 * the last one, which leaves out spam, snoozed, trashed and already-read mail,
 * and mailboxes the person no longer belongs to, without any bookkeeping.
 */

/** Most digests a single cron run sends (each is ~5 subrequests). */
const PER_RUN = 10;
/** Items listed in one digest; the rest are counted. */
const MAX_ITEMS = 20;
/** A claimed digest that fails retries this much later, with the same window. */
const RETRY_MS = 30 * 60_000;

export const isDigestHours = (n: unknown): n is DigestHours => (DIGEST_HOURS as readonly unknown[]).includes(n);

export const addHours = (iso: string, hours: number) => new Date(Date.parse(iso) + hours * 3_600_000).toISOString();

/** Why an address can't be the personal address, or null if it's fine. */
export function personalEmailProblem(email: string, loginEmail: string, brand: Pick<Brand, "primaryDomain" | "additionalDomains">): string | null {
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return "Enter a valid email address.";
  if (e === loginEmail.trim().toLowerCase()) return "Use a personal address, not your sign-in email.";
  if (mailDomains(brand).includes(domainOf(e))) return "Use an address outside the company, like a Gmail or iCloud address.";
  return null;
}

/** p***@gmail.com — for notices and lists that shouldn't show the whole address. */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}${"*".repeat(Math.max(2, Math.min(local.length - 1, 4)))}@${domain}`;
}

export interface DigestRow {
  id: string;
  mailbox_id: string;
  from_name: string;
  from_addr: string;
  subject: string;
  mailbox_address: string;
  mailbox_name: string;
}

/** Turn rows (newest first) plus per-mailbox counts into the template's groups, capped at MAX_ITEMS items. */
export function buildDigestGroups(rows: DigestRow[], counts: Map<string, number>, appUrl: string) {
  const base = appUrl.replace(/\/$/, "");
  const groups = new Map<string, { mailboxId: string; mailbox: string; count: number; items: { from: string; subject: string; url: string }[] }>();
  let listed = 0;
  for (const r of rows) {
    let g = groups.get(r.mailbox_id);
    if (!g) {
      g = { mailboxId: r.mailbox_id, mailbox: r.mailbox_name || r.mailbox_address, count: counts.get(r.mailbox_id) ?? 0, items: [] };
      groups.set(r.mailbox_id, g);
    }
    if (listed < MAX_ITEMS) {
      g.items.push({ from: r.from_name || r.from_addr, subject: r.subject, url: `${base}/mail/${r.mailbox_id}/inbox/${r.id}` });
      listed++;
    }
  }
  // Mailboxes with unread mail but none of it in the listed rows still get a line.
  for (const [mailboxId, count] of counts) {
    if (!groups.has(mailboxId)) {
      const sample = rows.find((r) => r.mailbox_id === mailboxId);
      groups.set(mailboxId, { mailboxId, mailbox: sample ? sample.mailbox_name || sample.mailbox_address : "Mailbox", count, items: [] });
    }
  }
  const list = [...groups.values()].sort((a, b) => b.count - a.count);
  return { groups: list, total: list.reduce((n, g) => n + g.count, 0) };
}

const WINDOW = `FROM mailbox_members mm
  JOIN mailboxes mb ON mb.id = mm.mailbox_id AND mb.is_active = 1 AND mb.is_system = 0
  JOIN messages m ON m.mailbox_id = mm.mailbox_id AND m.folder = 'inbox'
  WHERE mm.user_id = ?1 AND m.direction = 'inbound' AND m.is_read = 0
    AND m.created_at > ?2 AND m.created_at <= ?3
    AND m.from_addr <> ?4 COLLATE NOCASE`;

interface Claimed {
  id: string;
  email: string;
  name: string;
  personal_email: string;
  digest_last_at: string | null;
  digest_hours: number;
}

/** Cron entry: send the digests that are due. Returns how many were sent. */
export async function runDigests(env: Env, at = new Date()): Promise<number> {
  const policy = await getPolicy(env.DB);
  if (policy.digestDetail === "off") return 0;
  // Switched off in Admin > Features: people's digest settings are kept for when it's back on.
  if (!(await featureEnabled(env.DB, "digest"))) return 0;
  // Digests never eat the team's sending: stop at 90% of the daily limit.
  const usage = await quotaUsage(env);
  if (policy.dailySendLimit > 0 && usage.today >= policy.dailySendLimit * 0.9) return 0;
  if (policy.monthlySendLimit > 0 && usage.month >= policy.monthlySendLimit * 0.9) return 0;

  const t = at.toISOString();
  // Claim due users in one statement (D1 serializes writes, so overlapping runs can't
  // claim the same person); the provisional next time is the retry if this run dies.
  const { results: claimed } = await env.DB.prepare(
    `UPDATE users SET digest_next_at = ?2 WHERE id IN (
       SELECT id FROM users WHERE digest_enabled = 1 AND status = 'active'
         AND personal_email IS NOT NULL AND personal_email_verified_at IS NOT NULL
         AND digest_next_at <= ?1
       ORDER BY digest_next_at LIMIT ?3)
     RETURNING id, email, name, personal_email, digest_last_at, digest_hours`,
  )
    .bind(t, new Date(at.getTime() + RETRY_MS).toISOString(), PER_RUN)
    .all<Claimed>();
  if (!claimed.length) return 0;

  const brand = await getBrand(env.DB);
  let sent = 0;
  for (const user of claimed) {
    try {
      if (await sendOne(env, brand, policy.digestDetail === "count" ? "count" : "subjects", user, t)) sent++;
    } catch (err) {
      console.error("digest failed", user.id, err);
    }
  }
  return sent;
}

async function sendOne(env: Env, brand: Brand, detail: "subjects" | "count", user: Claimed, t: string): Promise<boolean> {
  const db = env.DB;
  const hours = isDigestHours(user.digest_hours) ? user.digest_hours : 5;
  const done = () => db.prepare("UPDATE users SET digest_last_at = ?, digest_next_at = ? WHERE id = ?").bind(t, addHours(t, hours), user.id).run();

  // A personal address that bounced or complained stops getting digests.
  const suppressed = await db.prepare("SELECT reason FROM suppressions WHERE email = ? AND reason IN ('bounced','complained')").bind(user.personal_email).first();
  if (suppressed) {
    await db.batch([
      db.prepare("UPDATE users SET digest_enabled = 0, digest_next_at = NULL WHERE id = ?").bind(user.id),
      db.prepare("INSERT INTO audit_logs (id, actor_id, actor_email, action, target_type, target_id, meta, created_at) VALUES (?, NULL, NULL, 'user.digest_disabled', 'user', ?, ?, ?)").bind(
        newId(),
        user.id,
        JSON.stringify({ via: "bounce" }),
        t,
      ),
    ]);
    return false;
  }

  const from = user.digest_last_at ?? addHours(t, -hours);
  const [{ results: rows }, { results: counts }] = await Promise.all([
    db
      .prepare(
        `SELECT m.id, m.mailbox_id, m.from_name, m.from_addr, m.subject, mb.address AS mailbox_address, mb.name AS mailbox_name ${WINDOW}
         ORDER BY m.created_at DESC LIMIT ${MAX_ITEMS + 1}`,
      )
      .bind(user.id, from, t, user.email)
      .all<DigestRow>(),
    db.prepare(`SELECT m.mailbox_id, COUNT(*) AS n ${WINDOW} GROUP BY m.mailbox_id`).bind(user.id, from, t, user.email).all<{ mailbox_id: string; n: number }>(),
  ]);

  // Nothing new (or they already read it): no email, next window starts now.
  if (!counts.length) {
    await done();
    return false;
  }

  const { groups, total } = buildDigestGroups(rows, new Map(counts.map((c) => [c.mailbox_id, c.n])), env.APP_URL);
  const app = env.APP_URL.replace(/\/$/, "");
  const offUrl = await digestOffUrl(app, env.SESSION_SECRET, user.id, user.personal_email);
  const ok = await sendSystemEmail(
    env,
    user.personal_email,
    templates.unreadDigest(brand, {
      name: user.name,
      total,
      detail,
      groups: groups.map((g) => ({ mailbox: g.mailbox, count: g.count, items: g.items })),
      openUrl: `${app}/mail/${groups[0]!.mailboxId}/inbox`,
      offUrl,
    }),
    "digest",
    { headers: unsubscribeHeaders(offUrl) },
  );
  // On failure the claim stands: it retries in 30 minutes with the same window.
  if (ok) await done();
  return ok;
}
