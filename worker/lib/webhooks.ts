import {
  DELIVERY_TIMEOUT_MS,
  MAX_PAYLOAD_BYTES,
  retryDelaySeconds,
  shouldAutoDisable,
  webhookUrlProblem,
  type WebhookEventMap,
  type WebhookEventType,
} from "@shared/webhooks";
import type { Env } from "../env";
import { auditSystem } from "./audit";
import { openSecret } from "./secret-box";
import { getWorkspace } from "./settings";
import { b64decode, b64encode, newId, now, parseJson } from "./util";

/**
 * Outbound webhooks (Admin → Webhooks). `emitEvent` queues one delivery per
 * subscribed endpoint and tries it right away in the background; failures are
 * retried by the cron with backoff (see RETRY_SCHEDULE_SECONDS) until they
 * succeed or run out of attempts.
 */

export const SECRET_PURPOSE = "webhook.signing_secret";
const enc = new TextEncoder();

export interface WaitUntil {
  waitUntil(p: Promise<unknown>): void;
}

/** A new signing secret in the Standard Webhooks format. */
export function generateWebhookSecret(): string {
  return `whsec_${b64encode(crypto.getRandomValues(new Uint8Array(32)))}`;
}

/** `v1,<base64 HMAC-SHA256>` of `${id}.${timestamp}.${body}`, keyed with the decoded secret. */
export async function signWebhook(secret: string, id: string, timestamp: number | string, body: string): Promise<string> {
  const keyBytes = b64decode(secret.startsWith("whsec_") ? secret.slice(6) : secret);
  const key = await crypto.subtle.importKey("raw", keyBytes as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${id}.${timestamp}.${body}`));
  return `v1,${b64encode(new Uint8Array(mac))}`;
}

/** The headers a delivery is sent with. */
export async function webhookHeaders(secret: string, id: string, body: string, nowSec = Math.floor(Date.now() / 1000)): Promise<Record<string, string>> {
  return {
    "content-type": "application/json",
    "user-agent": "InboxOS-Webhooks/1.0",
    "webhook-id": id,
    "webhook-timestamp": String(nowSec),
    "webhook-signature": await signWebhook(secret, id, nowSec, body),
  };
}

export interface QueuedEvent<T extends WebhookEventType = WebhookEventType> {
  type: T;
  data: WebhookEventMap[T];
}

/** The JSON body for an event: the same bytes are signed and sent on every attempt. */
export function eventBody(type: WebhookEventType, data: unknown, at = now()): string {
  return JSON.stringify({ type, timestamp: at, data });
}

/** Insert pending deliveries; returns their ids. Bodies over the size cap are logged as failed instead. */
async function enqueue(db: D1Database, rows: { endpointId: string; type: WebhookEventType; eventId: string; body: string }[]): Promise<string[]> {
  const t = now();
  const ids: string[] = [];
  const stmts = rows.map((r) => {
    const id = newId();
    const tooBig = enc.encode(r.body).byteLength > MAX_PAYLOAD_BYTES;
    if (!tooBig) ids.push(id);
    return db
      .prepare(
        `INSERT INTO webhook_deliveries (id, endpoint_id, event_type, event_id, payload, status, attempts, next_attempt_at, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .bind(
        id,
        r.endpointId,
        r.type,
        r.eventId,
        tooBig ? eventBody(r.type, { truncated: true }) : r.body,
        tooBig ? "failed" : "pending",
        tooBig ? null : t,
        tooBig ? `Not sent: the payload is over ${MAX_PAYLOAD_BYTES / 1024} KB.` : null,
        t,
      );
  });
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
  return ids;
}

/**
 * Queue events for every enabled endpoint subscribed to them and, with a `ctx`,
 * try delivering in the background straight away (otherwise the cron sends them
 * within a minute). Never throws: webhooks must not break the action behind them.
 */
export async function emitEvents(env: Env, ctx: WaitUntil | null | undefined, events: QueuedEvent[]): Promise<void> {
  if (!events.length) return;
  try {
    if (!(await getWorkspace(env.DB)).features.webhooks) return;
    const { results } = await env.DB.prepare("SELECT id, events FROM webhook_endpoints WHERE enabled = 1").all<{ id: string; events: string }>();
    if (!results.length) return;
    const subs = results.map((e) => ({ id: e.id, events: new Set(parseJson<string[]>(e.events, [])) }));
    const rows = events.flatMap((ev) => {
      const body = eventBody(ev.type, ev.data);
      const eventId = `msg_${newId()}`;
      return subs.filter((s) => s.events.has(ev.type)).map((s) => ({ endpointId: s.id, type: ev.type, eventId, body }));
    });
    if (!rows.length) return;
    const ids = await enqueue(env.DB, rows);
    const run = deliverMany(env, ids);
    if (ctx) ctx.waitUntil(run);
    else await run;
  } catch (err) {
    console.error("webhook emit failed", events[0]?.type, err);
  }
}

export function emitEvent<T extends WebhookEventType>(env: Env, ctx: WaitUntil | null | undefined, type: T, data: WebhookEventMap[T]): Promise<void> {
  return emitEvents(env, ctx, [{ type, data }]);
}

/** A request's execution context, or null where there is none (unit tests). */
export function requestCtx(c: { executionCtx: WaitUntil }): WaitUntil | null {
  try {
    return c.executionCtx;
  } catch {
    return null;
  }
}

/**
 * From a request handler: queue and deliver after the response is sent. Accepts
 * the events or a promise of them, so building them can't fail the request either.
 */
export function emitFromRequest(c: { env: Env; executionCtx: WaitUntil }, events: QueuedEvent[] | Promise<QueuedEvent[]>): void {
  const ctx = requestCtx(c);
  const p = Promise.resolve(events)
    .then((evs) => emitEvents(c.env, ctx, evs))
    .catch((err) => console.error("webhook events failed", err));
  if (ctx) ctx.waitUntil(p);
}

/** Queue one delivery to a specific endpoint, regardless of its subscriptions (test events, redelivery). */
export async function enqueueDirect(env: Env, endpointId: string, type: WebhookEventType, body: string, eventId = `msg_${newId()}`): Promise<string | null> {
  const [id] = await enqueue(env.DB, [{ endpointId, type, eventId, body }]);
  return id ?? null;
}

async function deliverMany(env: Env, ids: string[], concurrency = 6): Promise<void> {
  for (let i = 0; i < ids.length; i += concurrency) {
    await Promise.all(ids.slice(i, i + concurrency).map((id) => attemptDelivery(env, id).catch((err) => console.error("webhook delivery crashed", id, err))));
  }
}

async function readExcerpt(res: Response, max = 1000): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    /* a broken body still counts as a response */
  } finally {
    reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) (all.set(c, off), (off += c.byteLength));
  return new TextDecoder().decode(all).slice(0, max);
}

interface DeliveryJoin {
  id: string;
  endpoint_id: string;
  event_id: string;
  payload: string;
  attempts: number;
  url: string;
  secret: string;
  enabled: number;
  failure_streak: number;
  last_success_at: string | null;
  endpoint_created_at: string;
}

export interface AttemptResult {
  status: "succeeded" | "pending" | "failed";
  responseStatus: number | null;
  responseMs: number | null;
  error: string | null;
}

/** Send one queued delivery now. Returns null when it was already taken or isn't due. */
export async function attemptDelivery(env: Env, deliveryId: string): Promise<AttemptResult | null> {
  const db = env.DB;
  const t = now();
  // Claim it for long enough to finish, so the cron and an immediate attempt never both send it.
  const lease = new Date(Date.now() + DELIVERY_TIMEOUT_MS + 60_000).toISOString();
  const claim = await db
    .prepare("UPDATE webhook_deliveries SET next_attempt_at = ? WHERE id = ? AND status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)")
    .bind(lease, deliveryId, t)
    .run();
  if (!claim.meta.changes) return null;
  const d = await db
    .prepare(
      `SELECT d.id, d.endpoint_id, d.event_id, d.payload, d.attempts, e.url, e.secret, e.enabled, e.failure_streak, e.last_success_at,
         e.created_at AS endpoint_created_at
       FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id WHERE d.id = ?`,
    )
    .bind(deliveryId)
    .first<DeliveryJoin>();
  if (!d) return null;

  const giveUp = async (error: string): Promise<AttemptResult> => {
    await db
      .prepare("UPDATE webhook_deliveries SET status = 'failed', next_attempt_at = NULL, error = ? WHERE id = ?")
      .bind(error, d.id)
      .run();
    return { status: "failed", responseStatus: null, responseMs: null, error };
  };
  if (!d.enabled) return giveUp("Not sent: the endpoint is turned off.");
  const urlProblem = webhookUrlProblem(d.url);
  if (urlProblem) return giveUp(`Not sent: ${urlProblem}`);
  const secret = await openSecret(env.SESSION_SECRET, SECRET_PURPOSE, d.secret);
  if (!secret) return giveUp("Not sent: the signing secret can't be read (was SESSION_SECRET changed?). Rotate the secret.");

  const started = Date.now();
  let responseStatus: number | null = null;
  let excerpt: string | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(d.url, {
      method: "POST",
      headers: await webhookHeaders(secret, d.event_id, d.payload),
      body: d.payload,
      // Redirects could point anywhere (including private addresses); treat them as failures.
      redirect: "manual",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    responseStatus = res.status;
    excerpt = await readExcerpt(res);
    if (res.status < 200 || res.status >= 300) error = res.status >= 300 && res.status < 400 ? `Redirected (${res.status}); webhooks don't follow redirects` : `HTTP ${res.status}`;
  } catch (err) {
    const name = (err as Error)?.name;
    error = name === "TimeoutError" || name === "AbortError" ? `No response within ${DELIVERY_TIMEOUT_MS / 1000}s` : `Couldn't connect: ${(err as Error)?.message ?? "network error"}`.slice(0, 300);
  }
  const ms = Date.now() - started;
  const attempts = d.attempts + 1;
  const done = now();

  if (!error) {
    await db.batch([
      db
        .prepare(
          `UPDATE webhook_deliveries SET status = 'succeeded', attempts = ?, next_attempt_at = NULL, response_status = ?, response_ms = ?,
             response_excerpt = ?, error = NULL, delivered_at = ? WHERE id = ?`,
        )
        .bind(attempts, responseStatus, ms, excerpt, done, d.id),
      db.prepare("UPDATE webhook_endpoints SET last_success_at = ?, failure_streak = 0 WHERE id = ?").bind(done, d.endpoint_id),
    ]);
    return { status: "succeeded", responseStatus, responseMs: ms, error: null };
  }

  const delay = retryDelaySeconds(attempts);
  const status = delay === null ? "failed" : "pending";
  const next = delay === null ? null : new Date(Date.now() + delay * 1000).toISOString();
  await db.batch([
    db
      .prepare(
        `UPDATE webhook_deliveries SET status = ?, attempts = ?, next_attempt_at = ?, response_status = ?, response_ms = ?, response_excerpt = ?, error = ?
         WHERE id = ?`,
      )
      .bind(status, attempts, next, responseStatus, ms, excerpt, error, d.id),
    db.prepare("UPDATE webhook_endpoints SET last_failure_at = ?, failure_streak = failure_streak + 1 WHERE id = ?").bind(done, d.endpoint_id),
  ]);
  const streak = d.failure_streak + 1;
  if (shouldAutoDisable({ failureStreak: streak, lastSuccessAt: d.last_success_at, createdAt: d.endpoint_created_at })) {
    const off = await db
      .prepare("UPDATE webhook_endpoints SET enabled = 0, disabled_reason = ?, updated_at = ? WHERE id = ? AND enabled = 1")
      .bind(`Turned off automatically after ${streak} failed attempts in a row.`, done, d.endpoint_id)
      .run();
    if (off.meta.changes) {
      await auditSystem(db, { action: "webhook.auto_disabled", targetType: "webhook", targetId: d.endpoint_id, meta: { url: d.url, failureStreak: streak } });
    }
  }
  return { status, responseStatus, responseMs: ms, error };
}

/** Cron: retry deliveries that are due. Returns how many were attempted. */
export async function runWebhookDeliveries(env: Env, limit = 50): Promise<number> {
  if (!(await getWorkspace(env.DB)).features.webhooks) return 0;
  const { results } = await env.DB.prepare(
    "SELECT id FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?",
  )
    .bind(now(), limit)
    .all<{ id: string }>();
  await deliverMany(env, results.map((r) => r.id));
  return results.length;
}
