import { Hono } from "hono";
import type { AppEnv } from "../env";
import { ingestReceived, recordDeliveryEvent } from "../lib/inbound";
import { sendAutoReplies } from "../lib/mail-rules";
import { notifyReceived } from "../lib/notify";
import { getWebhookSecret } from "../lib/provider-config";
import { pushNewMail } from "../lib/push";
import { verifySvix } from "../lib/svix";
import { now } from "../lib/util";

export const webhookRoutes = new Hono<AppEnv>();

/**
 * Resend webhook receiver. Configure in Resend → Webhooks with URL
 * `${APP_URL}/webhooks/resend`, subscribe to all `email.*` events,
 * and keep the signing secret: the setup wizard registers the webhook and stores it,
 * or set it as the RESEND_WEBHOOK_SECRET Worker secret.
 */
webhookRoutes.post("/resend", async (c) => {
  const secret = await getWebhookSecret(c.env);
  if (!secret) return c.json({ error: "Webhook secret not configured" }, 503);
  const raw = await c.req.text();
  const id = c.req.header("svix-id") ?? null;
  const valid = await verifySvix(secret, { id, timestamp: c.req.header("svix-timestamp") ?? null, signature: c.req.header("svix-signature") ?? null }, raw);
  if (!valid) return c.json({ error: "Invalid signature" }, 401);

  // Resend retries on failure; skip events we've already processed.
  const fresh = await c.env.DB.prepare("INSERT OR IGNORE INTO webhook_receipts (id, created_at) VALUES (?, ?)").bind(id, now()).run();
  if (!fresh.meta.changes) return c.json({ ok: true, duplicate: true });

  let evt: { type: string; data: Record<string, unknown> & { email_id: string } };
  try {
    evt = JSON.parse(raw);
  } catch {
    return c.json({ error: "Bad JSON" }, 400);
  }

  try {
    if (evt.type === "email.received") {
      const r = await ingestReceived(c.env, evt.data);
      if (r.received.length) c.executionCtx.waitUntil(notifyReceived(c.env, r.received));
      if (r.received.length) c.executionCtx.waitUntil(pushNewMail(c.env, r.received));
      if (r.autoReplies.length) c.executionCtx.waitUntil(sendAutoReplies(c.env, r.autoReplies));
      return c.json({ ok: true, stored: r.stored, unrouted: r.unrouted });
    }
    if (evt.type.startsWith("email.")) {
      await recordDeliveryEvent(c.env, evt.type, evt.data, raw);
    }
    return c.json({ ok: true });
  } catch (err) {
    // Let Resend retry: forget the receipt so the retry isn't treated as a duplicate.
    console.error("webhook processing failed", evt.type, err);
    await c.env.DB.prepare("DELETE FROM webhook_receipts WHERE id = ?").bind(id).run();
    return c.json({ error: "Processing failed" }, 500);
  }
});
