import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireFeature } from "../lib/features";
import { audit } from "../lib/audit";
import { isPushEndpoint, pushToUser, vapidPublicKey } from "../lib/push";
import { rateLimit } from "../lib/ratelimit";
import { newId, now } from "../lib/util";
import { parseBody } from "../lib/validate";

/**
 * Web Push subscriptions for the signed-in person (one per device).
 *   GET    /api/push/key        the VAPID public key, or null if push isn't set up
 *   POST   /api/push/subscribe  { endpoint, keys: { p256dh, auth } }  (upsert; re-sent on every app start)
 *   DELETE /api/push/subscribe  { endpoint }
 *   POST   /api/push/test       send a test notification to this person's devices
 */
export const pushRoutes = new Hono<AppEnv>();
// Registering a device or sending a test needs push on; removing a device always works.
pushRoutes.use("*", requireFeature("push", { methods: ["POST"] }));

const zKey = z.string().regex(/^[A-Za-z0-9_-]+=*$/).max(200);

pushRoutes.get("/key", (c) => c.json({ publicKey: vapidPublicKey(c.env.VAPID_PRIVATE_JWK) }));

pushRoutes.post("/subscribe", async (c) => {
  if (!c.env.VAPID_PRIVATE_JWK) throw new HTTPException(503, { message: "Push notifications aren't set up on this server." });
  const body = await parseBody(c, z.object({ endpoint: z.string().url().max(1000), keys: z.object({ p256dh: zKey, auth: zKey }) }));
  if (!isPushEndpoint(body.endpoint)) throw new HTTPException(400, { message: "That isn't a supported push service." });
  const u = c.get("user");
  const t = now();
  // A device belongs to whoever signed in on it last.
  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
       user_agent = excluded.user_agent, failures = 0`,
  )
    .bind(newId(), u.id, body.endpoint, body.keys.p256dh, body.keys.auth, c.req.header("user-agent")?.slice(0, 300) ?? null, t)
    .run();
  return c.json({ ok: true });
});

pushRoutes.delete("/subscribe", async (c) => {
  const { endpoint } = await parseBody(c, z.object({ endpoint: z.string().max(1000) }));
  await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?").bind(endpoint, c.get("user").id).run();
  return c.json({ ok: true });
});

pushRoutes.post("/test", async (c) => {
  const u = c.get("user");
  if (!(await rateLimit(c.env.DB, `push-test:${u.id}`, 5, 600))) throw new HTTPException(429, { message: "Try again in a few minutes." });
  const delivered = await pushToUser(c.env, u.id, {
    title: "Notifications are on",
    body: "This is what new mail will look like.",
    url: "/",
    tag: "test",
  });
  if (!delivered) throw new HTTPException(400, { message: "No device accepted it. Turn notifications off and on again on this device." });
  await audit(c, { action: "user.push_test", targetType: "user", targetId: u.id, meta: { devices: delivered } });
  return c.json({ ok: true, devices: delivered });
});
