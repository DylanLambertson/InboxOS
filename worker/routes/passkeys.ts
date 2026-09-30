import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { mailDomains } from "@shared/brand";
import type { AppEnv } from "../env";
import { audit, clientIp, requestContext } from "../lib/audit";
import { templates } from "../lib/email-templates";
import { verifyPassword } from "../lib/password";
import {
  MAX_PASSKEYS,
  PASSKEY_ALGORITHMS,
  b64urlToBytes,
  challengeExpiry,
  cleanPasskeyName,
  consumeChallenge,
  counterOk,
  defaultPasskeyName,
  isRecentAuth,
  parseTransports,
  passkeyHosts,
  relyingParty,
  userHandleBytes,
  userHandleFor,
  type ChallengeKind,
  type ChallengeRow,
  type RelyingParty,
} from "../lib/passkeys";
import { rateLimit } from "../lib/ratelimit";
import { createSession } from "../lib/session";
import { ipRefused, recordSignIn } from "../lib/sign-ins";
import { IP_BLOCKED_MESSAGE } from "../lib/ip-allowlist";
import { getBrand, getPolicy } from "../lib/settings";
import { sendSystemEmail } from "../lib/system-mail";
import { verifyTotp } from "../lib/totp";
import { getUser } from "../lib/users";
import { b64url, newId, now, sha256hex } from "../lib/util";
import { parseBody } from "../lib/validate";

interface PasskeyRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  rp_id: string;
  name: string;
  backed_up: number;
  created_at: string;
  last_used_at: string | null;
}

// ---- Shared plumbing --------------------------------------------------------

export async function rpFor(c: Context<AppEnv>): Promise<RelyingParty | null> {
  const brand = await getBrand(c.env.DB);
  return relyingParty(c.req.url, passkeyHosts(c.env.APP_URL, mailDomains(brand)));
}

const secure = (c: Context<AppEnv>) => c.env.APP_URL.startsWith("https://");
// One cookie per ceremony so the login page's autofill can't clobber a passkey being added in another tab.
const challengeCookie = (c: Context<AppEnv>, kind: ChallengeKind) => `${secure(c) ? "__Host-" : ""}webauthn-${kind}`;

/** Store a challenge server-side and bind it to this browser with an HttpOnly cookie. */
async function saveChallenge(c: Context<AppEnv>, kind: ChallengeKind, challenge: string, rpId: string, userId: string | null) {
  const token = newId(32);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM webauthn_challenges WHERE expires_at < ?").bind(now()),
    c.env.DB.prepare("INSERT INTO webauthn_challenges (id, user_id, kind, challenge, rp_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)").bind(
      await sha256hex(token),
      userId,
      kind,
      challenge,
      rpId,
      challengeExpiry(Date.now()),
    ),
  ]);
  setCookie(c, challengeCookie(c, kind), token, { httpOnly: true, secure: secure(c), sameSite: "Strict", path: "/", maxAge: 300 });
}

/** Read and delete the challenge in one statement, so it can only ever be used once. */
async function takeChallenge(c: Context<AppEnv>, want: { kind: ChallengeKind; rpId: string; userId?: string }) {
  const name = challengeCookie(c, want.kind);
  const token = getCookie(c, name);
  deleteCookie(c, name, { path: "/", secure: secure(c) });
  const take = (id: string) => c.env.DB.prepare("DELETE FROM webauthn_challenges WHERE id = ? RETURNING *").bind(id).first<ChallengeRow>();
  return consumeChallenge(take, token ? await sha256hex(token) : null, want, now());
}

const noPasskeysHere = () =>
  new HTTPException(400, { message: "Passkeys aren't available on this address. Open the app at its usual mail.… address to use one." });

// Browser responses are base64url strings; cap sizes so junk can't be large.
const b64 = (max: number) => z.string().max(max).regex(/^[A-Za-z0-9_-]*$/, "Invalid encoding");
const zAuthResponse = z.object({
  id: b64(1400).min(1),
  rawId: b64(1400).min(1),
  type: z.literal("public-key"),
  response: z.object({
    clientDataJSON: b64(8000),
    authenticatorData: b64(8000),
    signature: b64(4000),
    userHandle: b64(1000).optional(),
  }),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
});
const zRegResponse = z.object({
  id: b64(1400).min(1),
  rawId: b64(1400).min(1),
  type: z.literal("public-key"),
  response: z.object({
    clientDataJSON: b64(8000),
    attestationObject: b64(64_000),
    authenticatorData: b64(64_000).optional(),
    transports: z.array(z.string().max(20)).max(10).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: b64(4000).optional(),
  }),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
});
const zReauth = z.object({ password: z.string().max(256).optional(), code: z.string().trim().max(20).optional() });

// ---- Sign in (public, mounted at /api/auth/passkey) --------------------------

export const passkeyAuthRoutes = new Hono<AppEnv>();

// One message for every failure, so responses don't reveal which credentials exist.
const SIGN_IN_FAILED = "That passkey didn't work. Passkeys only work on the address where they were added — try again, or sign in another way.";

passkeyAuthRoutes.post("/options", async (c) => {
  const ip = clientIp(c) ?? "unknown";
  // The login page asks once on load (for autofill) and again per button press.
  if (!(await rateLimit(c.env.DB, `passkey:options:${ip}`, 60, 600))) {
    throw new HTTPException(429, { message: "Too many attempts. Please wait a few minutes and try again." });
  }
  const rp = await rpFor(c);
  if (!rp) throw noPasskeysHere();
  // No allowCredentials: discoverable passkeys let the browser offer the right account itself.
  const options = await generateAuthenticationOptions({ rpID: rp.rpId, userVerification: "required", timeout: 120_000 });
  await saveChallenge(c, "login", options.challenge, rp.rpId, null);
  return c.json(options);
});

passkeyAuthRoutes.post("/verify", async (c) => {
  const ip = clientIp(c) ?? "unknown";
  if (!(await rateLimit(c.env.DB, `passkey:verify:${ip}`, 30, 600))) {
    throw new HTTPException(429, { message: "Too many attempts. Please wait a few minutes and try again." });
  }
  const body = await parseBody(c, zAuthResponse);
  const rp = await rpFor(c);
  if (!rp) throw noPasskeysHere();
  const ch = await takeChallenge(c, { kind: "login", rpId: rp.rpId });
  if (!ch.ok) throw new HTTPException(400, { message: "Your passkey sign-in timed out. Please try again." });

  const fail = async (reason: string, pk?: PasskeyRow) => {
    await audit(c, { action: "auth.passkey_failed", targetType: pk ? "user" : undefined, targetId: pk?.user_id, meta: { reason, rpId: rp.rpId }, actor: null });
    return new HTTPException(401, { message: SIGN_IN_FAILED });
  };

  const pk = await c.env.DB.prepare("SELECT * FROM passkeys WHERE credential_id = ? AND rp_id = ?").bind(body.id, rp.rpId).first<PasskeyRow>();
  if (!pk) throw await fail("unknown_credential");
  // The authenticator echoes the user handle we registered; it must belong to the same account.
  if (body.response.userHandle && body.response.userHandle !== userHandleFor(pk.user_id)) throw await fail("user_handle_mismatch", pk);

  let info;
  try {
    const v = await verifyAuthenticationResponse({
      response: body as AuthenticationResponseJSON,
      expectedChallenge: ch.row.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpId,
      credential: { id: pk.credential_id, publicKey: b64urlToBytes(pk.public_key), counter: pk.counter, transports: parseTransports(pk.transports) },
      requireUserVerification: true,
    });
    if (!v.verified || !v.authenticationInfo.userVerified) throw new Error("not verified");
    info = v.authenticationInfo;
  } catch (e) {
    const counter = e instanceof Error && /counter/i.test(e.message);
    throw await fail(counter ? "counter_regression" : "bad_signature", pk);
  }
  if (!counterOk(pk.counter, info.newCounter)) throw await fail("counter_regression", pk);

  // Only now that the signature checks out do we reveal anything about the account.
  const user = await getUser(c.env.DB, pk.user_id);
  if (!user || user.status !== "active") {
    await fail("inactive", pk);
    if (user) await recordSignIn(c, { outcome: "failed", method: "passkey", user, reason: "account_disabled" });
    throw new HTTPException(403, { message: "Your account has been disabled. Contact an administrator." });
  }
  // The IP allowlist applies to every way in, passkeys included.
  if (await ipRefused(c, await getPolicy(c.env.DB), { method: "passkey", user })) {
    throw new HTTPException(403, { message: IP_BLOCKED_MESSAGE });
  }
  // Same lockout as password sign-in, so an admin-visible lock means the account is really closed for a while.
  if (user.locked_until && user.locked_until > now()) {
    await recordSignIn(c, { outcome: "locked", method: "passkey", user });
    throw new HTTPException(423, { message: "Account temporarily locked after too many failed attempts. Try again later." });
  }
  // Compare-and-set so two simultaneous uses of a counting authenticator can't both pass.
  const t = now();
  const upd = await c.env.DB.prepare("UPDATE passkeys SET counter = ?, last_used_at = ?, backed_up = ? WHERE id = ? AND counter = ?")
    .bind(info.newCounter, t, info.credentialBackedUp ? 1 : 0, pk.id, pk.counter)
    .run();
  if (!upd.meta.changes) throw await fail("counter_race", pk);

  // A passkey with user verification is two factors in one (device + biometric/PIN): no TOTP step.
  await createSession(c, user.id);
  await c.env.DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(t, user.id).run();
  await recordSignIn(c, { outcome: "success", method: "passkey", user });
  await audit(c, {
    action: "auth.login",
    targetType: "user",
    targetId: user.id,
    actor: { id: user.id, email: user.email },
    meta: { method: "passkey", passkeyId: pk.id, rpId: rp.rpId },
  });
  return c.json({ ok: true });
});

// ---- Manage (signed in, mounted at /api/me/passkeys) -------------------------

export const passkeyMeRoutes = new Hono<AppEnv>();

async function sessionCreatedAt(c: Context<AppEnv>): Promise<string | null> {
  const row = await c.env.DB.prepare("SELECT created_at FROM sessions WHERE id = ?").bind(c.get("user").sessionId).first<{ created_at: string }>();
  return row?.created_at ?? null;
}

/**
 * Adding or removing a passkey changes how the account can be entered, so a stolen session
 * cookie alone mustn't be enough: the session must be fresh, or the password / a 2FA code re-entered.
 */
async function requireRecentAuth(c: Context<AppEnv>, body: z.infer<typeof zReauth>) {
  if (isRecentAuth(await sessionCreatedAt(c), Date.now())) return;
  const u = c.get("user");
  if (!body.password && !body.code) {
    throw new HTTPException(428, { message: "Confirm it's you with your password or a two-factor code." });
  }
  if (!(await rateLimit(c.env.DB, `reauth:${u.id}`, 8, 600))) {
    throw new HTTPException(429, { message: "Too many attempts. Please wait a few minutes and try again." });
  }
  const user = await getUser(c.env.DB, u.id);
  let ok = false;
  // With an authenticator app on, the code is required: password + cookie alone mustn't mint a new second factor.
  if (user?.totp_enabled && user.totp_secret) {
    const code = (body.code ?? "").replace(/\s/g, "");
    // Same replay guard as sign-in: one use per code.
    ok = code.length >= 6 && (await verifyTotp(user.totp_secret, code)) && (await rateLimit(c.env.DB, `totp-used:${user.id}:${code}`, 1, 120));
  } else if (body.password && user?.password_hash) ok = await verifyPassword(body.password, user.password_hash);
  if (!ok) {
    await audit(c, { action: "user.reauth_failed", targetType: "user", targetId: u.id });
    throw new HTTPException(400, { message: user?.totp_enabled ? "That two-factor code didn't work." : "That password is incorrect." });
  }
  await audit(c, { action: "user.reauth", targetType: "user", targetId: u.id, meta: { method: user?.totp_enabled ? "totp" : "password" } });
}

passkeyMeRoutes.get("/", async (c) => {
  const u = c.get("user");
  const [{ results }, rp, user, createdAt] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at").bind(u.id).all<PasskeyRow>(),
    rpFor(c),
    getUser(c.env.DB, u.id),
    sessionCreatedAt(c),
  ]);
  return c.json({
    passkeys: results.map((p) => ({
      id: p.id,
      name: p.name,
      host: p.rp_id,
      synced: !!p.backed_up,
      createdAt: p.created_at,
      lastUsedAt: p.last_used_at,
      usableHere: p.rp_id === rp?.rpId,
    })),
    host: rp?.rpId ?? null,
    recentAuth: isRecentAuth(createdAt, Date.now()),
    reauth: { password: !!user?.password_hash, totp: !!user?.totp_enabled },
    suggestedName: defaultPasskeyName(c.req.header("user-agent")),
    max: MAX_PASSKEYS,
  });
});

passkeyMeRoutes.post("/options", async (c) => {
  const body = await parseBody(c, zReauth);
  const u = c.get("user");
  if (!(await rateLimit(c.env.DB, `passkey:register:${u.id}`, 20, 600))) {
    throw new HTTPException(429, { message: "Too many attempts. Please wait a few minutes and try again." });
  }
  const rp = await rpFor(c);
  if (!rp) throw noPasskeysHere();
  await requireRecentAuth(c, body);
  const [{ results: mine }, brand] = await Promise.all([
    c.env.DB.prepare("SELECT credential_id, transports, rp_id FROM passkeys WHERE user_id = ?").bind(u.id).all<Pick<PasskeyRow, "credential_id" | "transports" | "rp_id">>(),
    getBrand(c.env.DB),
  ]);
  if (mine.length >= MAX_PASSKEYS) throw new HTTPException(400, { message: `You can have up to ${MAX_PASSKEYS} passkeys. Remove one first.` });
  const options = await generateRegistrationOptions({
    rpName: brand.productName,
    rpID: rp.rpId,
    userName: u.email,
    userID: userHandleBytes(u.id),
    userDisplayName: u.name || u.email,
    attestationType: "none",
    // Don't let the same authenticator register twice for this host.
    excludeCredentials: mine.filter((p) => p.rp_id === rp.rpId).map((p) => ({ id: p.credential_id, transports: parseTransports(p.transports) })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    supportedAlgorithmIDs: PASSKEY_ALGORITHMS,
    timeout: 120_000,
  });
  await saveChallenge(c, "register", options.challenge, rp.rpId, u.id);
  return c.json(options);
});

passkeyMeRoutes.post("/", async (c) => {
  const body = await parseBody(c, z.object({ name: z.string().max(200).optional(), response: zRegResponse }));
  const u = c.get("user");
  const rp = await rpFor(c);
  if (!rp) throw noPasskeysHere();
  const ch = await takeChallenge(c, { kind: "register", rpId: rp.rpId, userId: u.id });
  if (!ch.ok) throw new HTTPException(400, { message: "Adding the passkey timed out. Please try again." });

  let info;
  try {
    const v = await verifyRegistrationResponse({
      response: body.response as RegistrationResponseJSON,
      expectedChallenge: ch.row.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpId,
      requireUserVerification: true,
      supportedAlgorithmIDs: PASSKEY_ALGORITHMS,
    });
    if (!v.verified || !v.registrationInfo.userVerified) throw new Error("not verified");
    info = v.registrationInfo;
  } catch {
    await audit(c, { action: "user.passkey_add_failed", targetType: "user", targetId: u.id, meta: { rpId: rp.rpId } });
    throw new HTTPException(400, { message: "Your device couldn't create a passkey that we can verify. Please try again." });
  }

  const id = newId();
  const name = cleanPasskeyName(body.name, defaultPasskeyName(c.req.header("user-agent")));
  const transports = (body.response.response.transports ?? []).filter((t) => parseTransports(JSON.stringify([t])).length);
  const res = await c.env.DB.prepare(
    `INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, transports, rp_id, name, backed_up, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM passkeys WHERE user_id = ?) < ?
     ON CONFLICT(credential_id) DO NOTHING`,
  )
    .bind(id, u.id, info.credential.id, b64url(info.credential.publicKey), info.credential.counter, JSON.stringify(transports), rp.rpId, name, info.credentialBackedUp ? 1 : 0, now(), u.id, MAX_PASSKEYS)
    .run();
  if (!res.meta.changes) throw new HTTPException(409, { message: "This passkey is already registered, or you've reached the limit." });

  await audit(c, { action: "user.passkey_added", targetType: "user", targetId: u.id, meta: { passkeyId: id, name, rpId: rp.rpId, synced: info.credentialBackedUp } });
  const ctx = requestContext(c);
  c.executionCtx.waitUntil(
    getBrand(c.env.DB).then((brand) =>
      sendSystemEmail(c.env, u.email, templates.passkeyAdded(brand, { name: u.name, passkey: name, host: rp.rpId, appUrl: c.env.APP_URL, ctx }), "security"),
    ),
  );
  return c.json({ id, name }, 201);
});

passkeyMeRoutes.patch("/:id", async (c) => {
  const { name } = await parseBody(c, z.object({ name: z.string().max(200) }));
  const u = c.get("user");
  const clean = cleanPasskeyName(name);
  const res = await c.env.DB.prepare("UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ?").bind(clean, c.req.param("id"), u.id).run();
  if (!res.meta.changes) throw new HTTPException(404, { message: "Passkey not found" });
  await audit(c, { action: "user.passkey_renamed", targetType: "user", targetId: u.id, meta: { passkeyId: c.req.param("id"), name: clean } });
  return c.json({ ok: true });
});

passkeyMeRoutes.delete("/:id", async (c) => {
  const body = await parseBody(c, zReauth);
  const u = c.get("user");
  const pk = await c.env.DB.prepare("SELECT id, name, rp_id FROM passkeys WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), u.id)
    .first<Pick<PasskeyRow, "id" | "name" | "rp_id">>();
  if (!pk) throw new HTTPException(404, { message: "Passkey not found" });
  const [user, policy] = await Promise.all([getUser(c.env.DB, u.id), getPolicy(c.env.DB)]);
  if (policy.require2fa && !user?.totp_enabled && (user?.passkey_count ?? 0) <= 1) {
    throw new HTTPException(403, { message: "Your organization requires two-factor authentication. Add another passkey or set up an authenticator app first." });
  }
  await requireRecentAuth(c, body);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM passkeys WHERE id = ? AND user_id = ?").bind(pk.id, u.id),
    // A lost device may still be signed in: keep only this session.
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").bind(u.id, u.sessionId),
  ]);
  await audit(c, { action: "user.passkey_removed", targetType: "user", targetId: u.id, meta: { passkeyId: pk.id, name: pk.name, rpId: pk.rp_id } });
  return c.json({ ok: true });
});
