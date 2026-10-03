import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { DIGEST_HOURS } from "@shared/types";
import type { AppEnv } from "../env";
import { requireFeature, WRITES } from "../lib/features";
import { audit, clientIp, requestContext } from "../lib/audit";
import { addHours, isDigestHours, maskEmail, personalEmailProblem } from "../lib/digest";
import { templates } from "../lib/email-templates";
import { rateLimit } from "../lib/ratelimit";
import { getBrand, getPolicy } from "../lib/settings";
import { sendSystemEmail } from "../lib/system-mail";
import { verifyDigestOff } from "../lib/unsubscribe";
import { renderUnsubscribePage, UNSUBSCRIBE_CSP } from "../lib/unsubscribe-page";
import { getUser, toMe } from "../lib/users";
import { newId, now, parseJson, sha256hex } from "../lib/util";
import { parseBody, zEmail } from "../lib/validate";

/**
 * Unread-mail digest to a personal address.
 *
 *   digestSettingsRoutes (signed in, under /api/me):
 *     POST   /personal-email   { email }            send a confirmation link to the address
 *     DELETE /personal-email                        remove it (and stop digests)
 *     PATCH  /digest           { enabled?, hours? } turn on/off, change how often
 *   digestPublicRoutes (no sign-in, under /api/digest):
 *     POST   /verify-email     { token }            confirm the address (from the emailed link)
 *     GET|POST /off?u=&t=                           signed one-click "turn off" from the digest
 */
export const digestSettingsRoutes = new Hono<AppEnv>();
export const digestPublicRoutes = new Hono<AppEnv>();
// Setting up a digest needs the feature; removing a personal address always works.
digestSettingsRoutes.use("/personal-email", requireFeature("digest", { methods: ["POST"] }));
digestSettingsRoutes.use("/digest", requireFeature("digest", { methods: WRITES }));

const VERIFY_HOURS = 24;

digestSettingsRoutes.post("/personal-email", async (c) => {
  const { email } = await parseBody(c, z.object({ email: zEmail }));
  const u = c.get("user");
  const [brand, policy] = await Promise.all([getBrand(c.env.DB), getPolicy(c.env.DB)]);
  if (policy.digestDetail === "off") throw new HTTPException(403, { message: "Your organization has turned off email digests." });
  const problem = personalEmailProblem(email, u.email, brand);
  if (problem) throw new HTTPException(400, { message: problem });
  const blocked = await c.env.DB.prepare("SELECT 1 FROM suppressions WHERE email = ? AND reason IN ('bounced','complained')").bind(email).first();
  if (blocked) throw new HTTPException(400, { message: "Email to that address bounced before. Use a different one." });
  // Per person and per target address, so this can't be used to spam an outside inbox.
  if (!(await rateLimit(c.env.DB, `pemail:${u.id}`, 3, 3600)) || !(await rateLimit(c.env.DB, `pemail:addr:${email}`, 3, 86_400))) {
    throw new HTTPException(429, { message: "Too many confirmation emails. Try again later." });
  }

  const raw = newId(32);
  const t = now();
  await c.env.DB.batch([
    // Only the newest link works.
    c.env.DB.prepare("UPDATE tokens SET used_at = ? WHERE user_id = ? AND type = 'verify_email' AND used_at IS NULL").bind(t, u.id),
    c.env.DB.prepare("INSERT INTO tokens (id, user_id, type, data, expires_at, created_at) VALUES (?, ?, 'verify_email', ?, ?, ?)").bind(
      await sha256hex(raw),
      u.id,
      JSON.stringify({ email }),
      addHours(t, VERIFY_HOURS),
      t,
    ),
  ]);
  const url = `${c.env.APP_URL.replace(/\/$/, "")}/verify-email/${raw}`;
  const sent = await sendSystemEmail(c.env, email, templates.verifyPersonalEmail(brand, { name: u.name, url, account: u.email }), "verify_email");
  if (!sent) throw new HTTPException(502, { message: "Couldn't send the confirmation email. Try again in a minute." });
  await audit(c, { action: "user.personal_email_requested", targetType: "user", targetId: u.id, meta: { email: maskEmail(email) } });
  return c.json({ ok: true, pending: email });
});

digestSettingsRoutes.delete("/personal-email", async (c) => {
  const u = c.get("user");
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE users SET personal_email = NULL, personal_email_verified_at = NULL, digest_enabled = 0, digest_next_at = NULL, updated_at = ? WHERE id = ?",
    ).bind(now(), u.id),
    c.env.DB.prepare("UPDATE tokens SET used_at = ? WHERE user_id = ? AND type = 'verify_email' AND used_at IS NULL").bind(now(), u.id),
  ]);
  await audit(c, { action: "user.personal_email_removed", targetType: "user", targetId: u.id });
  return c.json(await meFor(c));
});

digestSettingsRoutes.patch("/digest", async (c) => {
  const body = await parseBody(
    c,
    z.object({ enabled: z.boolean().optional(), hours: z.number().int().refine(isDigestHours, `Choose one of ${DIGEST_HOURS.join(", ")} hours`).optional() }),
  );
  const u = c.get("user");
  const user = await getUser(c.env.DB, u.id);
  if (!user) throw new HTTPException(401, { message: "Not signed in" });
  const policy = await getPolicy(c.env.DB);
  const enabled = body.enabled ?? !!user.digest_enabled;
  const hours = body.hours ?? user.digest_hours ?? 5;
  if (enabled && policy.digestDetail === "off") throw new HTTPException(403, { message: "Your organization has turned off email digests." });
  if (enabled && !user.personal_email_verified_at) throw new HTTPException(400, { message: "Confirm a personal email first." });
  const t = now();
  const turningOn = enabled && !user.digest_enabled;
  // Turning on: the first digest covers mail from now on and comes `hours` from now.
  // Changing the frequency reschedules from the last digest.
  const lastAt = turningOn ? t : user.digest_last_at;
  await c.env.DB.prepare("UPDATE users SET digest_enabled = ?, digest_hours = ?, digest_last_at = ?, digest_next_at = ?, updated_at = ? WHERE id = ?")
    .bind(enabled ? 1 : 0, hours, lastAt, enabled ? addHours(lastAt ?? t, hours) : null, t, u.id)
    .run();
  if (body.enabled !== undefined && body.enabled !== !!user.digest_enabled) {
    await audit(c, { action: enabled ? "user.digest_enabled" : "user.digest_disabled", targetType: "user", targetId: u.id, meta: { hours } });
  }
  return c.json(await meFor(c));
});

async function meFor(c: Context<AppEnv>) {
  const [user, policy] = await Promise.all([getUser(c.env.DB, c.get("user").id), getPolicy(c.env.DB)]);
  if (!user) throw new HTTPException(401, { message: "Not signed in" });
  return toMe(user, policy);
}

// ---- Public ----------------------------------------------------------------

/** Confirm a personal address from the emailed link. The page POSTs on a button press, so link scanners can't. */
digestPublicRoutes.post("/verify-email", async (c) => {
  const { token } = await parseBody(c, z.object({ token: z.string().min(10).max(200) }));
  if (!(await rateLimit(c.env.DB, `verify-email:${clientIp(c) ?? "unknown"}`, 20, 3600))) {
    throw new HTTPException(429, { message: "Too many attempts. Try again later." });
  }
  const id = await sha256hex(token);
  const row = await c.env.DB.prepare("SELECT * FROM tokens WHERE id = ? AND type = 'verify_email'").bind(id).first<{
    user_id: string;
    data: string | null;
    expires_at: string;
    used_at: string | null;
  }>();
  if (!row || row.used_at || row.expires_at < now()) throw new HTTPException(404, { message: "This link is invalid or has expired. Send a new one from Settings." });
  const email = parseJson<{ email?: string }>(row.data, {}).email;
  const user = await getUser(c.env.DB, row.user_id);
  if (!email || !user || user.status !== "active") throw new HTTPException(404, { message: "This link is invalid or has expired." });
  const t = now();
  // Claim the token first so a double-click can't apply it twice.
  const claimed = await c.env.DB.prepare("UPDATE tokens SET used_at = ? WHERE id = ? AND used_at IS NULL").bind(t, id).run();
  if (!claimed.meta.changes) throw new HTTPException(404, { message: "This link was already used." });
  await c.env.DB.prepare(
    // A new address restarts the digest window; digests stay as the person left them (off until they turn them on).
    "UPDATE users SET personal_email = ?, personal_email_verified_at = ?, digest_last_at = CASE WHEN digest_enabled = 1 THEN ? ELSE digest_last_at END, updated_at = ? WHERE id = ?",
  )
    .bind(email, t, t, t, user.id)
    .run();
  await audit(c, { action: "user.personal_email_verified", targetType: "user", targetId: user.id, actor: { id: user.id, email: user.email }, meta: { email: maskEmail(email) } });
  // Tell the company address, in case it wasn't them.
  const ctx = requestContext(c);
  c.executionCtx.waitUntil(
    getBrand(c.env.DB).then((brand) =>
      sendSystemEmail(c.env, user.email, templates.personalEmailAdded(brand, { name: user.name, masked: maskEmail(email), appUrl: c.env.APP_URL, ctx }), "security"),
    ),
  );
  return c.json({ ok: true, email: maskEmail(email) });
});

async function offPage(c: Context<AppEnv>, kind: "digestConfirm" | "digestOff" | "invalid", status: 200 | 400 = 200) {
  const brand = await getBrand(c.env.DB);
  const url = new URL(c.req.url);
  return c.html(renderUnsubscribePage(brand, kind === "digestConfirm" ? { kind, action: url.pathname + url.search } : { kind }), status, {
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex",
    "Content-Security-Policy": UNSUBSCRIBE_CSP,
    "Referrer-Policy": "no-referrer",
  });
}

async function offTarget(c: Context<AppEnv>) {
  const userId = c.req.query("u");
  if (!userId) return null;
  const user = await c.env.DB.prepare("SELECT id, email, personal_email FROM users WHERE id = ?").bind(userId).first<{ id: string; email: string; personal_email: string | null }>();
  if (!user || !(await verifyDigestOff(c.env.SESSION_SECRET, user.id, user.personal_email, c.req.query("t")))) return null;
  return user;
}

// GET only asks (mail scanners open every link); POST turns it off. Mail apps' one-click requests POST too.
digestPublicRoutes.get("/off", async (c) => ((await offTarget(c)) ? offPage(c, "digestConfirm") : offPage(c, "invalid", 400)));
digestPublicRoutes.post("/off", async (c) => {
  const user = await offTarget(c);
  if (!user) return offPage(c, "invalid", 400);
  await c.env.DB.prepare("UPDATE users SET digest_enabled = 0, digest_next_at = NULL WHERE id = ?").bind(user.id).run();
  await audit(c, { action: "user.digest_disabled", targetType: "user", targetId: user.id, actor: { id: user.id, email: user.email }, meta: { via: "link" } });
  return offPage(c, "digestOff");
});
