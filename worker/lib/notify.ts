import type { Address } from "@shared/types";
import type { Env } from "../env";

/**
 * Outbound webhook: tell another service when mail arrives, so it
 * can badge unread and thread mail onto its own records without polling. Each notice
 * is one received message; the receiver verifies the HMAC before trusting it.
 */
export interface ReceivedNotice {
  mailboxId: string;
  message: { id: string; threadId: string; from: Address; subject: string; snippet: string; date: string };
}

const enc = new TextEncoder();

/** Hex HMAC-SHA256 of `${timestamp}.${body}`, so a replay with a stale timestamp is detectable. */
export async function signPayload(secret: string, body: string, timestamp: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${body}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function notifyReceived(env: Env, notices: ReceivedNotice[]): Promise<void> {
  const url = env.NOTIFY_WEBHOOK_URL;
  const secret = env.NOTIFY_WEBHOOK_SECRET;
  if (!url || !secret || !notices.length) return;

  const ids = [...new Set(notices.map((n) => n.mailboxId))];
  const { results } = await env.DB.prepare(`SELECT id, address FROM mailboxes WHERE id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids)
    .all<{ id: string; address: string }>();
  const address = new Map(results.map((r) => [r.id, r.address]));

  for (const n of notices) {
    const body = JSON.stringify({
      event: "message.received",
      mailbox: { id: n.mailboxId, address: address.get(n.mailboxId) ?? null },
      message: n.message,
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-inboxos-timestamp": timestamp,
          "x-inboxos-signature": `sha256=${await signPayload(secret, body, timestamp)}`,
        },
        body,
        // A slow or hung receiver must never keep the worker alive; the panel falls back to polling.
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) console.error("notify webhook rejected", res.status, n.message.id);
    } catch (err) {
      console.error("notify webhook failed", n.message.id, err);
    }
  }
}
