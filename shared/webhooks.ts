/**
 * Outbound webhooks: the events InboxOS can send to your own services, their
 * payloads, the retry schedule and the URL rules. Requests are signed per the
 * Standard Webhooks spec (https://www.standardwebhooks.com): headers
 * `webhook-id`, `webhook-timestamp` and `webhook-signature: v1,<base64 HMAC>`
 * over `${id}.${timestamp}.${body}`, keyed with the `whsec_…` secret.
 *
 * Every request body has the same envelope: `{ type, timestamp, data }`.
 */
import type { Address, Role, UserStatus } from "./types";

export interface MailboxRef {
  id: string;
  address: string | null;
}

/** A received or sent message, without its body. */
export interface MessageSummary {
  id: string;
  threadId: string;
  mailbox: MailboxRef;
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  snippet: string;
  hasAttachments: boolean;
  date: string;
}

/** A delivery update from the email provider about a message you sent. */
export interface DeliveryEventData {
  /** Our message id, when the provider id matched a stored message. */
  messageId: string | null;
  providerId: string;
  mailbox: MailboxRef | null;
  recipients: string[];
  detail: string | null;
  bounce?: { type?: string; subType?: string; message?: string };
  click?: { link?: string };
}

export interface UserEventData {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  /** What made the change: the admin console, a CSV import or SCIM. */
  via: "admin" | "import" | "bulk" | "scim";
}

export interface MailboxEventData {
  id: string;
  address: string;
  type: "personal" | "shared";
  via: "admin" | "import" | "bulk";
}

export interface WebhookEventMap {
  "message.received": MessageSummary & { folder: string };
  "message.sent": MessageSummary & { providerId: string };
  "message.delivered": DeliveryEventData;
  "message.bounced": DeliveryEventData;
  "message.complained": DeliveryEventData;
  "message.opened": DeliveryEventData;
  "message.clicked": DeliveryEventData;
  "user.created": UserEventData;
  "user.disabled": UserEventData;
  "user.deleted": Pick<UserEventData, "id" | "email" | "name" | "via">;
  "mailbox.created": MailboxEventData;
  "mailbox.deleted": Pick<MailboxEventData, "id" | "address" | "via">;
  ping: { message: string; endpointId: string };
}

export type WebhookEventType = keyof WebhookEventMap;

export interface WebhookPayload<T extends WebhookEventType = WebhookEventType> {
  type: T;
  timestamp: string;
  data: WebhookEventMap[T];
}

export interface WebhookEventInfo {
  label: string;
  description: string;
  group: "Mail" | "Delivery" | "People" | "Mailboxes";
}

/** Everything an endpoint can subscribe to. `ping` is only sent by "Send test event". */
export const WEBHOOK_EVENTS: Record<Exclude<WebhookEventType, "ping">, WebhookEventInfo> = {
  "message.received": { label: "Message received", description: "Mail arrived in a mailbox (not spam).", group: "Mail" },
  "message.sent": { label: "Message sent", description: "The provider accepted a message someone sent.", group: "Mail" },
  "message.delivered": { label: "Delivered", description: "The recipient's server accepted it.", group: "Delivery" },
  "message.bounced": { label: "Bounced", description: "It couldn't be delivered.", group: "Delivery" },
  "message.complained": { label: "Marked as spam", description: "The recipient reported it as spam.", group: "Delivery" },
  "message.opened": { label: "Opened", description: "The recipient opened it (when tracking is on).", group: "Delivery" },
  "message.clicked": { label: "Link clicked", description: "The recipient clicked a link (when tracking is on).", group: "Delivery" },
  "user.created": { label: "User added", description: "Someone was invited or imported.", group: "People" },
  "user.disabled": { label: "User disabled", description: "An account was disabled.", group: "People" },
  "user.deleted": { label: "User deleted", description: "An account was removed.", group: "People" },
  "mailbox.created": { label: "Mailbox created", description: "A new mailbox was added.", group: "Mailboxes" },
  "mailbox.deleted": { label: "Mailbox deleted", description: "A mailbox and its mail were removed.", group: "Mailboxes" },
};

export const SUBSCRIBABLE_EVENTS = Object.keys(WEBHOOK_EVENTS) as Exclude<WebhookEventType, "ping">[];
export const isWebhookEvent = (s: string): s is WebhookEventType => s === "ping" || s in WEBHOOK_EVENTS;

/** Provider delivery events and the webhook each one becomes. */
export const PROVIDER_EVENT_MAP: Record<string, WebhookEventType | undefined> = {
  "email.delivered": "message.delivered",
  "email.bounced": "message.bounced",
  "email.complained": "message.complained",
  "email.opened": "message.opened",
  "email.clicked": "message.clicked",
};

// ---- Delivery rules ----------------------------------------------------------

/** Wait before each retry, in seconds: 1m, 5m, 30m, 2h, 6h, 12h. Seven attempts in all over about 21 hours. */
export const RETRY_SCHEDULE_SECONDS = [60, 300, 1800, 7200, 21_600, 43_200] as const;
export const MAX_ATTEMPTS = RETRY_SCHEDULE_SECONDS.length + 1;
export const DELIVERY_TIMEOUT_MS = 10_000;
/** Request bodies larger than this are not sent. */
export const MAX_PAYLOAD_BYTES = 256 * 1024;
/** Endpoints per workspace. */
export const MAX_ENDPOINTS = 20;

/**
 * Seconds to wait after the given number of failed attempts, or null when the
 * delivery has used all its attempts and is given up on.
 */
export function retryDelaySeconds(failedAttempts: number): number | null {
  if (failedAttempts < 1) return 0;
  return failedAttempts <= RETRY_SCHEDULE_SECONDS.length ? RETRY_SCHEDULE_SECONDS[failedAttempts - 1] : null;
}

/** Consecutive failed attempts before an endpoint can be switched off automatically. */
export const AUTO_DISABLE_STREAK = 20;
/** …and only once it has also not succeeded for this long. */
export const AUTO_DISABLE_AFTER_MS = 3 * 86_400_000;

/**
 * Whether an endpoint has been failing long enough to switch it off: a streak
 * of failed attempts and no success (or, if it never succeeded, no life) for days.
 */
export function shouldAutoDisable(e: { failureStreak: number; lastSuccessAt: string | null; createdAt: string }, nowMs = Date.now()): boolean {
  if (e.failureStreak < AUTO_DISABLE_STREAK) return false;
  const since = Date.parse(e.lastSuccessAt ?? e.createdAt);
  return Number.isFinite(since) && nowMs - since >= AUTO_DISABLE_AFTER_MS;
}

// ---- URL safety -------------------------------------------------------------

function ipv4Private(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b, c] = m.slice(1).map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local (cloud metadata)
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast and reserved
  );
}

function ipv6Private(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!h.includes(":")) return false;
  if (h === "::" || h === "::1") return true;
  // IPv4-mapped (::ffff:10.0.0.1, or the hex form the URL parser produces).
  const mapped = /^::ffff:(.+)$/.exec(h);
  if (mapped) {
    const v = mapped[1];
    if (v.includes(".")) return ipv4Private(v);
    const parts = v.split(":").map((p) => parseInt(p, 16));
    if (parts.length === 2 && parts.every((n) => Number.isFinite(n))) {
      return ipv4Private([parts[0] >> 8, parts[0] & 255, parts[1] >> 8, parts[1] & 255].join("."));
    }
    return true;
  }
  const first = parseInt(h.split(":")[0] || "0", 16);
  return (
    (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xff00) === 0xff00 || // multicast
    h.startsWith("64:ff9b:") || // NAT64
    h.startsWith("2001:db8:") // documentation
  );
}

const BLOCKED_SUFFIXES = [".local", ".internal", ".localhost", ".lan", ".home.arpa", ".intranet", ".corp"];

/**
 * Why a webhook URL isn't allowed, or null when it is. Only public https URLs:
 * no localhost, private, link-local or reserved IP literals, no internal-only
 * hostnames and no credentials in the URL.
 */
export function webhookUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "Enter a full URL, like https://example.com/webhooks/inboxos.";
  }
  if (url.protocol !== "https:") return "Webhook URLs must start with https://.";
  if (url.username || url.password) return "Don't put a username or password in the URL. Verify the signature instead.";
  if (raw.length > 2000) return "That URL is too long.";
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return "Enter a full URL, like https://example.com/webhooks/inboxos.";
  if (host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return "That address only works inside a private network. Use a public URL.";
  if (ipv4Private(host) || ipv6Private(host)) return "Private, loopback and link-local IP addresses aren't allowed. Use a public URL.";
  if (/^\d+$/.test(host)) return "Enter a hostname or a public IP address.";
  if (!host.includes(".") && !host.includes(":")) return "Use a public hostname with a domain, like hooks.example.com.";
  return null;
}
