import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../env";
import { audit, clientIp, requestContext } from "../lib/audit";
import { hashPassword, passwordProblem, verifyPassword } from "../lib/password";
import { rateLimit } from "../lib/ratelimit";
import { needsPasskeySignIn } from "../lib/passkeys";
import { createSession, destroySession, readSession } from "../lib/session";
import { getBrand, getPolicy } from "../lib/settings";
import { templates } from "../lib/email-templates";
import { ipRefused, recordSignIn } from "../lib/sign-ins";
import { sendSystemEmail } from "../lib/system-mail";
import { verifyTotp } from "../lib/totp";
import { getUser, getUserForSignIn } from "../lib/users";
import { IP_BLOCKED_MESSAGE } from "../lib/ip-allowlist";
import { newId, now, parseJson, sha256hex } from "../lib/util";
import { parseBody, zEmail } from "../lib/validate";
import { googleRoutes } from "./auth-google";
import { rpFor } from "./passkeys";

export const authRoutes = new Hono<AppEnv>();

const GENERIC = "Incorrect email or password.";
const LOCK_AFTER = 10;
const LOCK_MINUTES = 15;

/** Public info the sign-in screen needs. */
authRoutes.get("/options", async (c) => {
  const [policy, rp] = await Promise.all([getPolicy(c.env.DB), rpFor(c)]);
  return c.json({
    password: policy.passwordLoginEnabled,
    google: policy.googleSsoEnabled && !!c.env.GOOGLE_CLIENT_ID && !!c.env.GOOGLE_CLIENT_SECRET,
    // Passkeys work whatever the password/Google settings, on any app host.
    passkeys: !!rp,
  });
});

authRoutes.get("/state", async (c) => {
  const s = await readSession(c, true);
  return c.json({ signedIn: !!s && !s.mfa_pending, mfaPending: !!s?.mfa_pending });
});

authRoutes.post("/login", async (c) => {
  const { email, password } = await parseBody(c, z.object({ email: zEmail, password: z.string().min(1).max(256) }));
  const ip = clientIp(c) ?? "unknown";
  if (!(await rateLimit(c.env.DB, `login:ip:${ip}`, 30, 600)) || !(await rateLimit(c.env.DB, `login:email:${email}`, 12, 900))) {
    throw new HTTPException(429, { message: "Too many attempts. Please wait a few minutes and try again." });
  }
  const policy = await getPolicy(c.env.DB);
  // Their sign-in email, or the work address of a personal mailbox they own.
  const user = await getUserForSignIn(c.env.DB, email);
  // Before the password check, so a blocked network can't test passwords. Without a known
  // active account only an "everyone" allowlist applies, so this can't reveal who exists.
  const known = user && user.status === "active" && user.password_hash ? user : null;
  if (await ipRefused(c, policy, { method: "password", user: known, email })) {
    throw new HTTPException(403, { message: IP_BLOCKED_MESSAGE });
  }
  if (!user || user.status !== "active" || !user.password_hash) {
    await hashPassword(password); // equalize timing for unknown accounts
    await audit(c, { action: "auth.login_failed", meta: { email, reason: "unknown_or_inactive" }, actor: null });
    await recordSignIn(c, { outcome: "failed", method: "password", email, reason: "unknown_or_inactive" });
    throw new HTTPException(401, { message: GENERIC });
  }
  if (!policy.passwordLoginEnabled && user.role !== "owner") {
    await recordSignIn(c, { outcome: "failed", method: "password", user, reason: "password_login_disabled" });
    throw new HTTPException(403, { message: "Password sign-in is disabled. Use Google sign-in." });
  }
  if (user.locked_until && user.locked_until > now()) {
    await recordSignIn(c, { outcome: "locked", method: "password", user });
    throw new HTTPException(423, { message: "Account temporarily locked after too many failed attempts. Try again later." });
  }
  if (!(await verifyPassword(password, user.password_hash))) {
    const failures = user.failed_logins + 1;
    const lock = failures >= LOCK_AFTER ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null;
    await c.env.DB.prepare("UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?")
      .bind(lock ? 0 : failures, lock, user.id)
      .run();
    await audit(c, { action: "auth.login_failed", targetType: "user", targetId: user.id, meta: { email, locked: !!lock }, actor: null });
    await recordSignIn(c, { outcome: lock ? "locked" : "failed", method: "password", user, reason: lock ? "too_many_failures" : "wrong_password" });
    throw new HTTPException(401, { message: GENERIC });
  }
  await c.env.DB.prepare("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?").bind(user.id).run();

  if (needsPasskeySignIn(policy.require2fa, !!user.totp_enabled, user.passkey_count ?? 0)) {
    await audit(c, { action: "auth.login_failed", targetType: "user", targetId: user.id, meta: { email, reason: "passkey_required" }, actor: null });
    throw new HTTPException(403, { message: "Your organization requires two-factor sign-in. Use \"Sign in with a passkey\" on the address where you added it." });
  }
  if (user.totp_enabled) {
    await createSession(c, user.id, { mfaPending: true });
    return c.json({ mfaRequired: true });
  }
  await createSession(c, user.id);
  await c.env.DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(now(), user.id).run();
  await audit(c, { action: "auth.login", targetType: "user", targetId: user.id, actor: { id: user.id, email: user.email }, meta: { method: "password" } });
  await recordSignIn(c, { outcome: "success", method: "password", user });
  return c.json({ ok: true });
});

authRoutes.post("/2fa", async (c) => {
  const { code } = await parseBody(c, z.object({ code: z.string().trim().min(6).max(20) }));
  const s = await readSession(c, true);
  if (!s?.mfa_pending) throw new HTTPException(401, { message: "Your sign-in expired. Please start again." });
  if (!(await rateLimit(c.env.DB, `2fa:${s.id}`, 8, 600))) {
    throw new HTTPException(429, { message: "Too many attempts. Please sign in again later." });
  }
  const user = await getUser(c.env.DB, s.id);
  if (!user?.totp_secret) throw new HTTPException(401, { message: "Two-factor is not set up." });
  if (await ipRefused(c, await getPolicy(c.env.DB), { method: "password+2fa", user })) {
    throw new HTTPException(403, { message: IP_BLOCKED_MESSAGE });
  }

  // A code is valid for ~90s; refuse a second use so a shoulder-surfed or phished code can't be replayed.
  let ok = (await verifyTotp(user.totp_secret, code)) && (await rateLimit(c.env.DB, `totp-used:${user.id}:${code.replace(/\s/g, "")}`, 1, 120));
  let usedRecovery = false;
  if (!ok) {
    const hashes = parseJson<string[]>(user.recovery_codes, []);
    const h = await sha256hex(code.replace(/[\s-]/g, "").toLowerCase());
    if (hashes.includes(h)) {
      ok = true;
      usedRecovery = true;
      await c.env.DB.prepare("UPDATE users SET recovery_codes = ? WHERE id = ?")
        .bind(JSON.stringify(hashes.filter((x) => x !== h)), user.id)
        .run();
    }
  }
  if (!ok) {
    await audit(c, { action: "auth.2fa_failed", targetType: "user", targetId: user.id, actor: { id: user.id, email: user.email } });
    await recordSignIn(c, { outcome: "2fa_failed", method: "password+2fa", user });
    throw new HTTPException(401, { message: "That code didn't work. Check your authenticator app and try again." });
  }
  await destroySession(c);
  await createSession(c, user.id);
  await c.env.DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(now(), user.id).run();
  await audit(c, {
    action: "auth.login",
    targetType: "user",
    targetId: user.id,
    actor: { id: user.id, email: user.email },
    meta: { method: "password+2fa", usedRecovery },
  });
  await recordSignIn(c, { outcome: "success", method: "password+2fa", user, reason: usedRecovery ? "recovery_code" : undefined });
  return c.json({ ok: true });
});

authRoutes.post("/logout", async (c) => {
  const s = await readSession(c, true);
  await destroySession(c);
  if (s) await audit(c, { action: "auth.logout", actor: { id: s.id, email: s.email } });
  return c.json({ ok: true });
});

// ---- Invites & password resets --------------------------------------------

async function loadToken(db: D1Database, raw: string, type: "invite" | "reset") {
  const row = await db
    .prepare("SELECT * FROM tokens WHERE id = ? AND type = ?")
    .bind(await sha256hex(raw), type)
    .first<{ id: string; user_id: string; expires_at: string; used_at: string | null }>();
  if (!row || row.used_at || row.expires_at < now()) return null;
  return row;
}

authRoutes.get("/invite/:token", async (c) => {
  const tok = await loadToken(c.env.DB, c.req.param("token"), "invite");
  const user = tok ? await getUser(c.env.DB, tok.user_id) : null;
  if (!tok || !user || user.status === "disabled") throw new HTTPException(404, { message: "This invite link is invalid or has expired." });
  const brand = await getBrand(c.env.DB);
  return c.json({ email: user.email, name: user.name, company: brand.companyName });
});

authRoutes.post("/invite/accept", async (c) => {
  const body = await parseBody(c, z.object({ token: z.string().min(10), name: z.string().trim().min(1).max(120), password: z.string() }));
  const problem = passwordProblem(body.password);
  if (problem) throw new HTTPException(400, { message: problem });
  const tok = await loadToken(c.env.DB, body.token, "invite");
  const user = tok ? await getUser(c.env.DB, tok.user_id) : null;
  if (!tok || !user || user.status === "disabled") throw new HTTPException(404, { message: "This invite link is invalid or has expired." });
  const t = now();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET name = ?, password_hash = ?, status = 'active', updated_at = ?, last_login_at = ? WHERE id = ?").bind(
      body.name,
      await hashPassword(body.password),
      t,
      t,
      user.id,
    ),
    c.env.DB.prepare("UPDATE tokens SET used_at = ? WHERE id = ?").bind(t, tok.id),
  ]);
  await createSession(c, user.id);
  await audit(c, { action: "user.invite_accepted", targetType: "user", targetId: user.id, actor: { id: user.id, email: user.email } });
  c.executionCtx.waitUntil(
    (async () => {
      const [brand, { results }] = await Promise.all([
        getBrand(c.env.DB),
        c.env.DB.prepare(
          "SELECT m.address FROM mailbox_members mm JOIN mailboxes m ON m.id = mm.mailbox_id WHERE mm.user_id = ? AND m.is_active = 1 AND m.is_system = 0 ORDER BY m.address",
        )
          .bind(user.id)
          .all<{ address: string }>(),
      ]);
      await sendSystemEmail(
        c.env,
        user.email,
        templates.welcome(brand, { name: body.name, email: user.email, appUrl: c.env.APP_URL, mailboxes: results.map((r) => r.address) }),
        "welcome",
      );
    })(),
  );
  return c.json({ ok: true });
});

authRoutes.post("/forgot", async (c) => {
  const { email } = await parseBody(c, z.object({ email: zEmail }));
  const ip = clientIp(c) ?? "unknown";
  if (!(await rateLimit(c.env.DB, `forgot:${ip}`, 5, 900))) {
    throw new HTTPException(429, { message: "Too many requests. Try again later." });
  }
  const user = await getUserForSignIn(c.env.DB, email);
  // Always respond the same way, and as fast, so the endpoint can't be used to discover accounts:
  // the token and email are handled after the response.
  if (user && user.status === "active") {
    const ctx = requestContext(c);
    c.executionCtx.waitUntil(
      (async () => {
        const raw = newId(32);
        await c.env.DB.batch([
          // Only the newest reset link stays valid.
          c.env.DB.prepare("UPDATE tokens SET used_at = ? WHERE user_id = ? AND type = 'reset' AND used_at IS NULL").bind(now(), user.id),
          c.env.DB.prepare("INSERT INTO tokens (id, user_id, type, expires_at, created_at) VALUES (?, ?, 'reset', ?, ?)").bind(
            await sha256hex(raw),
            user.id,
            new Date(Date.now() + 60 * 60_000).toISOString(),
            now(),
          ),
        ]);
        const brand = await getBrand(c.env.DB);
        await sendSystemEmail(
          c.env,
          user.email,
          templates.reset(brand, { name: user.name, url: `${c.env.APP_URL.replace(/\/$/, "")}/reset/${raw}`, expires: "1 hour", ctx }),
          "password_reset",
        );
        await audit(c, { action: "auth.reset_requested", targetType: "user", targetId: user.id, actor: null });
      })(),
    );
  }
  return c.json({ ok: true });
});

authRoutes.post("/reset", async (c) => {
  const body = await parseBody(c, z.object({ token: z.string().min(10), password: z.string() }));
  const problem = passwordProblem(body.password);
  if (problem) throw new HTTPException(400, { message: problem });
  const tok = await loadToken(c.env.DB, body.token, "reset");
  if (!tok) throw new HTTPException(404, { message: "This reset link is invalid or has expired." });
  const t = now();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?").bind(
      await hashPassword(body.password),
      t,
      tok.user_id,
    ),
    c.env.DB.prepare("UPDATE tokens SET used_at = ? WHERE id = ?").bind(t, tok.id),
    // Sign out everywhere after a reset.
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(tok.user_id),
  ]);
  await audit(c, { action: "auth.password_reset", targetType: "user", targetId: tok.user_id, actor: null });
  const user = await getUser(c.env.DB, tok.user_id);
  if (user) {
    const ctx = requestContext(c);
    c.executionCtx.waitUntil(
      getBrand(c.env.DB).then((brand) =>
        sendSystemEmail(c.env, user.email, templates.passwordChanged(brand, { name: user.name, appUrl: c.env.APP_URL, ctx }), "security"),
      ),
    );
  }
  // Whoever holds the emailed link may see which address the account signs in with.
  return c.json({ ok: true, email: user?.email ?? null });
});

authRoutes.route("/google", googleRoutes);
