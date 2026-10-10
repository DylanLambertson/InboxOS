import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { MAX_ENDPOINTS, SUBSCRIBABLE_EVENTS, webhookUrlProblem } from "@shared/webhooks";
import type { AppEnv } from "../env";
import { audit } from "../lib/audit";
import { maskSecret, sealSecret } from "../lib/secret-box";
import { getWorkspace } from "../lib/settings";
import { clampInt, newId, now, parseJson } from "../lib/util";
import { parseBody } from "../lib/validate";
import { attemptDelivery, enqueueDirect, eventBody, generateWebhookSecret, SECRET_PURPOSE } from "../lib/webhooks";

/** Admin → Webhooks: endpoints, their signing secrets, test events and the delivery log. */
export const adminWebhookRoutes = new Hono<AppEnv>();

/** Webhooks can be switched off in Admin → Features; the API then behaves as if it isn't there. */
const requireWebhooks: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!(await getWorkspace(c.env.DB)).features.webhooks) {
    throw new HTTPException(404, { message: "Webhooks are turned off. Turn them on in Admin → Features." });
  }
  await next();
};
adminWebhookRoutes.use("*", requireWebhooks);

interface EndpointRow {
  id: string;
  url: string;
  description: string;
  events: string;
  secret: string;
  enabled: number;
  disabled_reason: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  last_success_at: string | null;
  last_failure_at: string | null;
  failure_streak: number;
}

const zUrl = z
  .string()
  .trim()
  .max(2000)
  .superRefine((v, ctx) => {
    const problem = webhookUrlProblem(v);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });
const zEvents = z.array(z.enum(SUBSCRIBABLE_EVENTS as [string, ...string[]])).min(1, "Pick at least one event.").max(50);
const isId = (s: string) => /^[A-Za-z0-9_-]{1,64}$/.test(s);

async function loadEndpoint(db: D1Database, id: string): Promise<EndpointRow> {
  if (!isId(id)) throw new HTTPException(400, { message: "Invalid endpoint" });
  const row = await db.prepare("SELECT * FROM webhook_endpoints WHERE id = ?").bind(id).first<EndpointRow>();
  if (!row) throw new HTTPException(404, { message: "Webhook endpoint not found" });
  return row;
}

adminWebhookRoutes.get("/", async (c) => {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const [{ results }, { results: stats }] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM webhook_endpoints ORDER BY created_at").all<EndpointRow>(),
    c.env.DB.prepare(
      "SELECT endpoint_id, status, COUNT(*) AS n FROM webhook_deliveries WHERE created_at >= ? GROUP BY endpoint_id, status",
    )
      .bind(since)
      .all<{ endpoint_id: string; status: string; n: number }>(),
  ]);
  return c.json(
    results.map((e) => {
      const count = (s: string) => stats.find((x) => x.endpoint_id === e.id && x.status === s)?.n ?? 0;
      return {
        id: e.id,
        url: e.url,
        description: e.description,
        events: parseJson<string[]>(e.events, []),
        enabled: !!e.enabled,
        disabledReason: e.disabled_reason,
        createdAt: e.created_at,
        updatedAt: e.updated_at,
        lastSuccessAt: e.last_success_at,
        lastFailureAt: e.last_failure_at,
        failureStreak: e.failure_streak,
        last24h: { succeeded: count("succeeded"), failed: count("failed"), pending: count("pending") },
      };
    }),
  );
});

adminWebhookRoutes.post("/", async (c) => {
  const body = await parseBody(
    c,
    z.object({ url: zUrl, description: z.string().trim().max(200).default(""), events: zEvents, enabled: z.boolean().default(true) }),
  );
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM webhook_endpoints").first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_ENDPOINTS) throw new HTTPException(400, { message: `You can have up to ${MAX_ENDPOINTS} webhook endpoints.` });
  const id = newId();
  const secret = generateWebhookSecret();
  const t = now();
  await c.env.DB.prepare(
    `INSERT INTO webhook_endpoints (id, url, description, events, secret, enabled, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, body.url, body.description, JSON.stringify(body.events), await sealSecret(c.env.SESSION_SECRET, SECRET_PURPOSE, secret), body.enabled ? 1 : 0, c.get("user").id, t, t)
    .run();
  await audit(c, { action: "webhook.created", targetType: "webhook", targetId: id, meta: { url: body.url, events: body.events } });
  // The only time the secret leaves the server in full.
  return c.json({ id, secret }, 201);
});

adminWebhookRoutes.patch("/:id", async (c) => {
  const e = await loadEndpoint(c.env.DB, c.req.param("id"));
  const body = await parseBody(
    c,
    z.object({ url: zUrl.optional(), description: z.string().trim().max(200).optional(), events: zEvents.optional(), enabled: z.boolean().optional() }),
  );
  const reenabled = body.enabled === true && !e.enabled;
  await c.env.DB.prepare(
    `UPDATE webhook_endpoints SET url = ?, description = ?, events = ?, enabled = ?, updated_at = ?,
       disabled_reason = CASE WHEN ? THEN NULL ELSE disabled_reason END, failure_streak = CASE WHEN ? THEN 0 ELSE failure_streak END
     WHERE id = ?`,
  )
    .bind(
      body.url ?? e.url,
      body.description ?? e.description,
      body.events ? JSON.stringify(body.events) : e.events,
      body.enabled === undefined ? e.enabled : body.enabled ? 1 : 0,
      now(),
      reenabled ? 1 : 0,
      reenabled ? 1 : 0,
      e.id,
    )
    .run();
  await audit(c, { action: "webhook.updated", targetType: "webhook", targetId: e.id, meta: { ...body, previousUrl: body.url && body.url !== e.url ? e.url : undefined } });
  return c.json({ ok: true });
});

adminWebhookRoutes.delete("/:id", async (c) => {
  const e = await loadEndpoint(c.env.DB, c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM webhook_endpoints WHERE id = ?").bind(e.id).run();
  await audit(c, { action: "webhook.deleted", targetType: "webhook", targetId: e.id, meta: { url: e.url } });
  return c.json({ ok: true });
});

adminWebhookRoutes.post("/:id/rotate-secret", async (c) => {
  const e = await loadEndpoint(c.env.DB, c.req.param("id"));
  const secret = generateWebhookSecret();
  await c.env.DB.prepare("UPDATE webhook_endpoints SET secret = ?, updated_at = ? WHERE id = ?")
    .bind(await sealSecret(c.env.SESSION_SECRET, SECRET_PURPOSE, secret), now(), e.id)
    .run();
  await audit(c, { action: "webhook.secret_rotated", targetType: "webhook", targetId: e.id, meta: { url: e.url, hint: maskSecret(secret) } });
  return c.json({ secret });
});

/** Send a `ping` now and report what came back. */
adminWebhookRoutes.post("/:id/test", async (c) => {
  const e = await loadEndpoint(c.env.DB, c.req.param("id"));
  if (!e.enabled) throw new HTTPException(400, { message: "Turn the endpoint on before sending a test event." });
  const body = eventBody("ping", { message: "Test event from InboxOS. If you can read this, your endpoint works.", endpointId: e.id });
  const deliveryId = await enqueueDirect(c.env, e.id, "ping", body);
  const result = deliveryId ? await attemptDelivery(c.env, deliveryId) : null;
  await audit(c, { action: "webhook.test_sent", targetType: "webhook", targetId: e.id, meta: { url: e.url, result: result?.status ?? "not_sent" } });
  return c.json({ deliveryId, result });
});

// ---- Delivery log --------------------------------------------------------------

interface DeliveryRow {
  id: string;
  endpoint_id: string;
  event_type: string;
  event_id: string;
  payload?: string;
  status: string;
  attempts: number;
  next_attempt_at: string | null;
  response_status: number | null;
  response_ms: number | null;
  response_excerpt?: string | null;
  error: string | null;
  created_at: string;
  delivered_at: string | null;
}

const deliveryJson = (d: DeliveryRow) => ({
  id: d.id,
  endpointId: d.endpoint_id,
  eventType: d.event_type,
  eventId: d.event_id,
  status: d.status,
  attempts: d.attempts,
  nextAttemptAt: d.status === "pending" ? d.next_attempt_at : null,
  responseStatus: d.response_status,
  responseMs: d.response_ms,
  error: d.error,
  createdAt: d.created_at,
  deliveredAt: d.delivered_at,
  ...(d.payload !== undefined ? { payload: d.payload, responseExcerpt: d.response_excerpt ?? null } : {}),
});

adminWebhookRoutes.get("/:id/deliveries", async (c) => {
  const e = await loadEndpoint(c.env.DB, c.req.param("id"));
  const status = c.req.query("status") ?? "";
  const event = c.req.query("event") ?? "";
  const cursor = c.req.query("cursor") ?? "";
  if (status && !["pending", "succeeded", "failed"].includes(status)) throw new HTTPException(400, { message: "Invalid status" });
  if (event && !/^[a-z.]{1,40}$/.test(event)) throw new HTTPException(400, { message: "Invalid event" });
  if (cursor && Number.isNaN(Date.parse(cursor))) throw new HTTPException(400, { message: "Invalid cursor" });
  const limit = clampInt(c.req.query("limit"), 1, 100, 30);
  const { results } = await c.env.DB.prepare(
    `SELECT id, endpoint_id, event_type, event_id, status, attempts, next_attempt_at, response_status, response_ms, error, created_at, delivered_at
     FROM webhook_deliveries WHERE endpoint_id = ?1 AND (?2 = '' OR status = ?2) AND (?3 = '' OR event_type = ?3) AND (?4 = '' OR created_at < ?4)
     ORDER BY created_at DESC LIMIT ?5`,
  )
    .bind(e.id, status, event, cursor, limit + 1)
    .all<DeliveryRow>();
  const page = results.slice(0, limit);
  return c.json({ items: page.map(deliveryJson), nextCursor: results.length > limit ? page[page.length - 1].created_at : null });
});

async function loadDelivery(db: D1Database, id: string): Promise<DeliveryRow> {
  if (!isId(id)) throw new HTTPException(400, { message: "Invalid delivery" });
  const d = await db.prepare("SELECT * FROM webhook_deliveries WHERE id = ?").bind(id).first<DeliveryRow>();
  if (!d) throw new HTTPException(404, { message: "Delivery not found. It may have been cleaned up by log retention." });
  return d;
}

adminWebhookRoutes.get("/deliveries/:deliveryId", async (c) => c.json(deliveryJson(await loadDelivery(c.env.DB, c.req.param("deliveryId")))));

/** Send the same event again (same webhook-id, so receivers can still de-duplicate). */
adminWebhookRoutes.post("/deliveries/:deliveryId/redeliver", async (c) => {
  const d = await loadDelivery(c.env.DB, c.req.param("deliveryId"));
  const e = await loadEndpoint(c.env.DB, d.endpoint_id);
  if (!e.enabled) throw new HTTPException(400, { message: "Turn the endpoint on before redelivering." });
  if (parseJson<{ data?: { truncated?: boolean } }>(d.payload, {}).data?.truncated) {
    throw new HTTPException(400, { message: "This event was too large to send, so it can't be redelivered." });
  }
  const deliveryId = await enqueueDirect(c.env, e.id, d.event_type as "ping", d.payload!, d.event_id);
  const result = deliveryId ? await attemptDelivery(c.env, deliveryId) : null;
  await audit(c, { action: "webhook.redelivered", targetType: "webhook", targetId: e.id, meta: { deliveryId: d.id, eventType: d.event_type, result: result?.status ?? "not_sent" } });
  return c.json({ deliveryId, result });
});
