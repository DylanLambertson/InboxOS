import { DEFAULT_PREFERENCES, type Preferences } from "@shared/types";
import type { Env } from "../env";
import type { ReceivedNotice } from "./notify";
import { getBrand } from "./settings";
import { b64url, b64decode, parseJson } from "./util";
import { buildPushRequest } from "./webpush";

/**
 * Web Push for new mail: a notification on every device (browser or installed app)
 * where a mailbox member turned notifications on. Runs after the webhook answers.
 */

/** Push services we deliver to. Subscriptions name their own endpoint, so anything else is refused (no SSRF). */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];

export function isPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && !url.port && PUSH_HOSTS.some((re) => re.test(url.hostname));
  } catch {
    return false;
  }
}

/** The VAPID public key (uncompressed P-256 point, base64url) for the browser, from the private JWK's x and y. */
export function vapidPublicKey(privateJwk: string | undefined): string | null {
  const jwk = parseJson<{ x?: string; y?: string } | null>(privateJwk ?? null, null);
  if (!jwk?.x || !jwk?.y) return null;
  const decode = (s: string) => b64decode(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const x = decode(jwk.x);
  const y = decode(jwk.y);
  if (x.length !== 32 || y.length !== 32) return null;
  const point = new Uint8Array(65);
  point[0] = 4;
  point.set(x, 1);
  point.set(y, 33);
  return b64url(point);
}

export interface PushPayload {
  title: string;
  body: string;
  /** Where tapping the notification goes. */
  url: string;
  /** Notifications with the same tag replace each other (one per mailbox). */
  tag: string;
  /** Unread count for the app icon badge. */
  badge?: number;
}

/** What the lock screen shows: sender and subject, or just the mailbox when the person hid details. */
export function newMailPayload(n: ReceivedNotice, mailbox: string, showDetails: boolean, unread?: number): PushPayload {
  const from = n.message.from.name || n.message.from.email;
  return {
    title: showDetails ? from.slice(0, 80) : `New mail in ${mailbox}`,
    body: showDetails ? (n.message.subject || "(no subject)").slice(0, 140) : "Open the app to read it.",
    url: `/mail/${n.mailboxId}/inbox/${n.message.id}`,
    tag: `mail-${n.mailboxId}`,
    ...(unread !== undefined ? { badge: unread } : {}),
  };
}

interface Target {
  sub_id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  preferences: string;
}

/** After new mail is stored: push it to every member's devices. Never throws. */
export async function pushNewMail(env: Env, notices: ReceivedNotice[]): Promise<void> {
  if (!env.VAPID_PRIVATE_JWK || !notices.length) return;
  try {
    const brand = await getBrand(env.DB);
    const contact = brand.supportEmail ? `mailto:${brand.supportEmail}` : `mailto:no-reply@${brand.primaryDomain}`;
    for (const n of notices) {
      const { results } = await env.DB.prepare(
        `SELECT ps.id AS sub_id, ps.user_id, ps.endpoint, ps.p256dh, ps.auth, u.preferences
         FROM mailbox_members mm
         JOIN users u ON u.id = mm.user_id AND u.status = 'active'
         JOIN push_subscriptions ps ON ps.user_id = mm.user_id
         WHERE mm.mailbox_id = ? AND lower(u.email) <> lower(?)
         LIMIT 200`,
      )
        .bind(n.mailboxId, n.message.from.email)
        .all<Target>();
      if (!results.length) continue;
      const mailbox = await env.DB.prepare("SELECT name, address FROM mailboxes WHERE id = ?").bind(n.mailboxId).first<{ name: string; address: string }>();
      const label = mailbox?.name || mailbox?.address || "your mailbox";
      const unread = await unreadByUser(env.DB, [...new Set(results.map((r) => r.user_id))]);
      await Promise.allSettled(
        results.map((t) => {
          const prefs: Preferences = { ...DEFAULT_PREFERENCES, ...parseJson<Partial<Preferences>>(t.preferences, {}) };
          return deliver(env, t, newMailPayload(n, label, prefs.pushShowDetails, unread.get(t.user_id)), contact);
        }),
      );
    }
  } catch (err) {
    console.error("push failed", err);
  }
}

/** Send one payload to every device of one person (e.g. a test notification). Returns how many accepted it. */
export async function pushToUser(env: Env, userId: string, payload: PushPayload): Promise<number> {
  if (!env.VAPID_PRIVATE_JWK) return 0;
  const brand = await getBrand(env.DB);
  const contact = brand.supportEmail ? `mailto:${brand.supportEmail}` : `mailto:no-reply@${brand.primaryDomain}`;
  const { results } = await env.DB.prepare(
    "SELECT id AS sub_id, user_id, endpoint, p256dh, auth, '{}' AS preferences FROM push_subscriptions WHERE user_id = ?",
  )
    .bind(userId)
    .all<Target>();
  const outcomes = await Promise.all(results.map((t) => deliver(env, t, payload, contact)));
  return outcomes.filter(Boolean).length;
}

/** Unread inbox mail per person, across their mailboxes, for the icon badge. */
async function unreadByUser(db: D1Database, userIds: string[]): Promise<Map<string, number>> {
  if (!userIds.length) return new Map();
  const { results } = await db
    .prepare(
      `SELECT mm.user_id, COUNT(*) AS n FROM mailbox_members mm
       JOIN mailboxes mb ON mb.id = mm.mailbox_id AND mb.is_active = 1 AND mb.is_system = 0
       JOIN messages m ON m.mailbox_id = mm.mailbox_id AND m.folder = 'inbox' AND m.is_read = 0
       WHERE mm.user_id IN (${userIds.map(() => "?").join(",")}) GROUP BY mm.user_id`,
    )
    .bind(...userIds)
    .all<{ user_id: string; n: number }>();
  return new Map(results.map((r) => [r.user_id, r.n]));
}

async function deliver(env: Env, t: Target, payload: PushPayload, contact: string): Promise<boolean> {
  if (!isPushEndpoint(t.endpoint)) {
    await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(t.sub_id).run();
    return false;
  }
  try {
    const req = await buildPushRequest({
      endpoint: t.endpoint,
      keys: { p256dh: t.p256dh, auth: t.auth },
      payload,
      privateJwk: JSON.parse(env.VAPID_PRIVATE_JWK!) as JsonWebKey,
      subject: contact,
      ttl: 86_400,
      urgency: "high",
      // A newer push for the same mailbox replaces an undelivered older one.
      topic: payload.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32),
    });
    const res = await fetch(t.endpoint, { method: "POST", headers: req.headers, body: req.body });
    if (res.status === 404 || res.status === 410) {
      // The device unsubscribed or the app was removed.
      await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(t.sub_id).run();
      return false;
    }
    if (res.ok) {
      await env.DB.prepare("UPDATE push_subscriptions SET failures = 0, last_ok_at = ? WHERE id = ?").bind(new Date().toISOString(), t.sub_id).run();
      return true;
    }
    console.error("push rejected", res.status, new URL(t.endpoint).hostname);
    await countFailure(env, t.sub_id);
    return false;
  } catch (err) {
    console.error("push error", err);
    await countFailure(env, t.sub_id);
    return false;
  }
}

/** Five failures in a row and the subscription is dropped. */
async function countFailure(env: Env, id: string) {
  await env.DB.batch([
    env.DB.prepare("UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ?").bind(id),
    env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ? AND failures >= 5").bind(id),
  ]);
}
