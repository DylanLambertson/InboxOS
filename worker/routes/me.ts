import { Hono, type Context } from "hono";
import type { Brand } from "@shared/brand";
import type { EmailContent } from "../lib/email-layout";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { migratePreferences, PREFERENCES_VERSION, type Preferences } from "@shared/types";
import type { AppEnv } from "../env";
import { audit, requestContext } from "../lib/audit";
import { templates } from "../lib/email-templates";
import { sendSystemEmail } from "../lib/system-mail";
import { hashPassword, passwordProblem, verifyPassword } from "../lib/password";
import { signatureMode } from "../lib/outbound";
import { getBrand, getPolicy } from "../lib/settings";
import { generateTotpSecret, totpUri, verifyTotp } from "../lib/totp";
import { getUser, toMe } from "../lib/users";
import { now, parseJson, sha256hex } from "../lib/util";
import { parseBody } from "../lib/validate";
import { PROFILE_COLUMNS, zProfilePatch, type ProfilePatch } from "../lib/profile";

export const meRoutes = new Hono<AppEnv>();

/** Fire-and-forget security notification to the signed-in user. */
function securityEmail(c: Context<AppEnv>, build: (brand: Brand) => EmailContent) {
  const to = c.get("user").email;
  c.executionCtx.waitUntil(getBrand(c.env.DB).then((brand) => sendSystemEmail(c.env, to, build(brand), "security")));
}

meRoutes.get("/", async (c) => {
  const [user, policy] = await Promise.all([getUser(c.env.DB, c.get("user").id), getPolicy(c.env.DB)]);
  if (!user) throw new HTTPException(401, { message: "Not signed in" });
  return c.json(toMe(user, policy));
});

const zPrefs = z
  .object({
    theme: z.enum(["workspace", "system", "light", "dark"]),
    density: z.enum(["workspace", "compact", "comfortable", "spacious"]),
    undoSendSeconds: z.number().int().min(0).max(30),
    loadRemoteImages: z.boolean(),
    markReadOnOpen: z.boolean(),
    composeMode: z.enum(["docked", "fullscreen"]),
    conversationView: z.boolean(),
    desktopNotifications: z.boolean(),
    pushShowDetails: z.boolean(),
  })
  .partial();

meRoutes.patch("/", async (c) => {
  const body = await parseBody(c, zProfilePatch.extend({ signatureHtml: z.string().max(20_000).optional(), preferences: zPrefs.optional() }));
  const uid = c.get("user").id;
  const user = await getUser(c.env.DB, uid);
  if (!user) throw new HTTPException(404);
  if (body.signatureHtml !== undefined && (await signatureMode(c.env.DB)) === "enforce") {
    throw new HTTPException(403, { message: "Your organization sets everyone's signature. Ask an admin to change it." });
  }
  const prefs: Preferences = { ...migratePreferences(parseJson<unknown>(user.preferences, {})), ...body.preferences, v: PREFERENCES_VERSION };
  const sets: string[] = ["signature_html = ?", "preferences = ?", "updated_at = ?"];
  const args: unknown[] = [body.signatureHtml ?? user.signature_html, JSON.stringify(prefs), now()];
  for (const [field, column] of Object.entries(PROFILE_COLUMNS) as [keyof ProfilePatch, string][]) {
    if (body[field] === undefined) continue;
    sets.push(`${column} = ?`);
    args.push(body[field]);
  }
  await c.env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...args, uid)
    .run();
  const updated = await getUser(c.env.DB, uid);
  return c.json(toMe(updated!, await getPolicy(c.env.DB)));
});

meRoutes.post("/password", async (c) => {
  const body = await parseBody(c, z.object({ current: z.string().optional(), next: z.string() }));
  const u = c.get("user");
  const user = await getUser(c.env.DB, u.id);
  if (!user) throw new HTTPException(404);
  if (user.password_hash && !(await verifyPassword(body.current ?? "", user.password_hash))) {
    throw new HTTPException(400, { message: "Your current password is incorrect." });
  }
  const problem = passwordProblem(body.next);
  if (problem) throw new HTTPException(400, { message: problem });
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").bind(await hashPassword(body.next), now(), u.id),
    // Keep this session, revoke all others.
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").bind(u.id, u.sessionId),
  ]);
  await audit(c, { action: "user.password_changed", targetType: "user", targetId: u.id });
  securityEmail(c, (brand) => templates.passwordChanged(brand, { name: user.name, appUrl: c.env.APP_URL, ctx: requestContext(c) }));
  return c.json({ ok: true });
});

// ---- Two-factor -----------------------------------------------------------

meRoutes.post("/2fa/setup", async (c) => {
  const u = c.get("user");
  const secret = generateTotpSecret();
  await c.env.DB.prepare("UPDATE users SET totp_secret = ? WHERE id = ? AND totp_enabled = 0").bind(secret, u.id).run();
  const brand = await getBrand(c.env.DB);
  return c.json({ secret, uri: totpUri(secret, u.email, brand.productName) });
});

function makeRecoveryCodes(): string[] {
  return Array.from({ length: 10 }, () => {
    const s = [...crypto.getRandomValues(new Uint8Array(5))].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

meRoutes.post("/2fa/enable", async (c) => {
  const { code } = await parseBody(c, z.object({ code: z.string().trim() }));
  const u = c.get("user");
  const user = await getUser(c.env.DB, u.id);
  if (!user?.totp_secret) throw new HTTPException(400, { message: "Start setup first." });
  if (user.totp_enabled) throw new HTTPException(400, { message: "Two-factor is already on." });
  if (!(await verifyTotp(user.totp_secret, code))) throw new HTTPException(400, { message: "That code didn't match. Try the newest code." });
  const codes = makeRecoveryCodes();
  const hashes = await Promise.all(codes.map((x) => sha256hex(x.replace("-", ""))));
  await c.env.DB.prepare("UPDATE users SET totp_enabled = 1, recovery_codes = ?, updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(hashes), now(), u.id)
    .run();
  await audit(c, { action: "user.2fa_enabled", targetType: "user", targetId: u.id });
  securityEmail(c, (brand) => templates.twoFactor(brand, { name: user.name, enabled: true, appUrl: c.env.APP_URL, ctx: requestContext(c) }));
  return c.json({ recoveryCodes: codes });
});

meRoutes.post("/2fa/disable", async (c) => {
  const { code } = await parseBody(c, z.object({ code: z.string().trim() }));
  const u = c.get("user");
  const [user, policy] = await Promise.all([getUser(c.env.DB, u.id), getPolicy(c.env.DB)]);
  if (!user?.totp_enabled || !user.totp_secret) throw new HTTPException(400, { message: "Two-factor is not on." });
  // A passkey also satisfies the requirement, so the authenticator app can go.
  if (policy.require2fa && !user.passkey_count) throw new HTTPException(403, { message: "Your organization requires two-factor authentication." });
  if (!(await verifyTotp(user.totp_secret, code))) throw new HTTPException(400, { message: "That code didn't match." });
  await c.env.DB.prepare("UPDATE users SET totp_enabled = 0, totp_secret = NULL, recovery_codes = NULL, updated_at = ? WHERE id = ?")
    .bind(now(), u.id)
    .run();
  await audit(c, { action: "user.2fa_disabled", targetType: "user", targetId: u.id });
  securityEmail(c, (brand) => templates.twoFactor(brand, { name: user.name, enabled: false, appUrl: c.env.APP_URL, ctx: requestContext(c) }));
  return c.json({ ok: true });
});

meRoutes.post("/google/unlink", async (c) => {
  const u = c.get("user");
  const user = await getUser(c.env.DB, u.id);
  if (!user?.password_hash) throw new HTTPException(400, { message: "Set a password first so you can still sign in." });
  await c.env.DB.prepare("UPDATE users SET google_sub = NULL, updated_at = ? WHERE id = ?").bind(now(), u.id).run();
  await audit(c, { action: "user.google_unlinked", targetType: "user", targetId: u.id });
  return c.json({ ok: true });
});

// ---- Sessions -------------------------------------------------------------

meRoutes.get("/sessions", async (c) => {
  const u = c.get("user");
  const { results } = await c.env.DB.prepare(
    "SELECT id, ip, user_agent, created_at, last_seen_at FROM sessions WHERE user_id = ? AND mfa_pending = 0 AND expires_at > ? ORDER BY last_seen_at DESC",
  )
    .bind(u.id, now())
    .all<{ id: string; ip: string | null; user_agent: string | null; created_at: string; last_seen_at: string }>();
  // Session ids are token hashes; expose a short opaque handle only.
  return c.json(
    results.map((s) => ({
      id: s.id.slice(0, 16),
      ip: s.ip,
      userAgent: s.user_agent,
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      current: s.id === u.sessionId,
    })),
  );
});

meRoutes.delete("/sessions/:handle", async (c) => {
  const u = c.get("user");
  const handle = c.req.param("handle");
  if (!/^[0-9a-f]{16}$/.test(handle)) throw new HTTPException(400);
  await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND substr(id, 1, 16) = ? AND id != ?").bind(u.id, handle, u.sessionId).run();
  await audit(c, { action: "user.session_revoked", targetType: "user", targetId: u.id });
  return c.json({ ok: true });
});

meRoutes.post("/sessions/revoke-others", async (c) => {
  const u = c.get("user");
  await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").bind(u.id, u.sessionId).run();
  await audit(c, { action: "user.sessions_revoked", targetType: "user", targetId: u.id });
  return c.json({ ok: true });
});

