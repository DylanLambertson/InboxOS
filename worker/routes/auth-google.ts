import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv } from "../env";
import { audit } from "../lib/audit";
import { appOrigin } from "../lib/domains";
import { needsPasskeySignIn } from "../lib/passkeys";
import { createSession, readSession } from "../lib/session";
import { getBrand, getPolicy } from "../lib/settings";
import { ipRefused, recordSignIn } from "../lib/sign-ins";
import { ensureMailbox, getUserByEmail, insertUser, withRole, type UserRow } from "../lib/users";
import { b64decode, domainOf, newId, now, parseJson, sha256hex } from "../lib/util";

export const googleRoutes = new Hono<AppEnv>();

const STATE_COOKIE = "oauth_state";

interface StateData {
  mode: "login" | "link";
  userId?: string;
  next: string;
}

// Google sends the user back to the host they started on (mail.example.com or mail.example.org),
// so the state cookie is there. Every such callback URL must be listed in the Google OAuth client.
const redirectUri = async (env: AppEnv["Bindings"], requestUrl: string) =>
  `${await appOrigin(env.DB, env.APP_URL, requestUrl)}/api/auth/google/callback`;
const safeNext = (n: string | undefined) => (n && n.startsWith("/") && !n.startsWith("//") ? n : "/");

googleRoutes.get("/start", async (c) => {
  const policy = await getPolicy(c.env.DB);
  if (!policy.googleSsoEnabled || !c.env.GOOGLE_CLIENT_ID) return c.redirect("/login?error=google_disabled");

  const mode = c.req.query("mode") === "link" ? "link" : "login";
  let userId: string | undefined;
  if (mode === "link") {
    const s = await readSession(c);
    if (!s) return c.redirect("/login");
    // Linking changes how the account signs in, so it obeys the allowlist like any signed-in request.
    if (await ipRefused(c, policy, { method: "session", user: { id: s.id, email: s.email, role: s.role } })) return c.redirect("/login?error=ip_blocked");
    userId = s.id;
  }
  const raw = newId(24);
  const data: StateData = { mode, userId, next: safeNext(c.req.query("next")) };
  await c.env.DB.prepare("INSERT INTO tokens (id, type, data, expires_at, created_at) VALUES (?, 'oauth_state', ?, ?, ?)")
    .bind(await sha256hex(raw), JSON.stringify(data), new Date(Date.now() + 10 * 60_000).toISOString(), now())
    .run();
  setCookie(c, STATE_COOKIE, raw, {
    httpOnly: true,
    secure: c.env.APP_URL.startsWith("https://"),
    sameSite: "Lax",
    path: "/api/auth/google",
    maxAge: 600,
  });
  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: await redirectUri(c.env, c.req.url),
    response_type: "code",
    scope: "openid email profile",
    state: raw,
    prompt: "select_account",
  });
  if (policy.googleAllowedDomains.length === 1) params.set("hd", policy.googleAllowedDomains[0]);
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

interface IdClaims {
  iss: string;
  aud: string;
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  hd?: string;
  exp: number;
}

googleRoutes.get("/callback", async (c) => {
  const fail = (code: string) => c.redirect(`/login?error=${code}`);
  const state = c.req.query("state");
  const code = c.req.query("code");
  const cookie = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: "/api/auth/google" });
  if (!state || !code || !cookie || state !== cookie) return fail("google_state");

  const stateRow = await c.env.DB.prepare("SELECT * FROM tokens WHERE id = ? AND type = 'oauth_state' AND used_at IS NULL")
    .bind(await sha256hex(state))
    .first<{ id: string; data: string; expires_at: string }>();
  if (!stateRow || stateRow.expires_at < now()) return fail("google_state");
  await c.env.DB.prepare("UPDATE tokens SET used_at = ? WHERE id = ?").bind(now(), stateRow.id).run();
  const data = parseJson<StateData>(stateRow.data, { mode: "login", next: "/" });

  // Exchange the code directly with Google over TLS (OIDC §3.1.3.7 allows skipping signature checks here).
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: c.env.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: await redirectUri(c.env, c.req.url),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return fail("google_exchange");
  const { id_token } = (await tokenRes.json()) as { id_token?: string };
  if (!id_token) return fail("google_exchange");
  const payload = id_token.split(".")[1] ?? "";
  const claims = JSON.parse(new TextDecoder().decode(b64decode(payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=")))) as IdClaims;
  if (
    claims.aud !== c.env.GOOGLE_CLIENT_ID ||
    !["https://accounts.google.com", "accounts.google.com"].includes(claims.iss) ||
    claims.exp * 1000 < Date.now() ||
    !claims.email_verified
  ) {
    return fail("google_token");
  }
  const email = claims.email.toLowerCase();
  const policy = await getPolicy(c.env.DB);

  if (data.mode === "link" && data.userId) {
    const taken = await c.env.DB.prepare("SELECT id FROM users WHERE google_sub = ? AND id != ?").bind(claims.sub, data.userId).first();
    if (taken) return c.redirect("/settings/security?error=google_in_use");
    await c.env.DB.prepare("UPDATE users SET google_sub = ?, updated_at = ? WHERE id = ?").bind(claims.sub, now(), data.userId).run();
    await audit(c, { action: "user.google_linked", targetType: "user", targetId: data.userId, actor: { id: data.userId, email } });
    return c.redirect("/settings/security?linked=1");
  }

  const allowed = policy.googleAllowedDomains.map((d) => d.toLowerCase());
  const domainOk = !allowed.length || allowed.includes((claims.hd ?? domainOf(email)).toLowerCase());

  let user =
    withRole(await c.env.DB.prepare("SELECT * FROM users WHERE google_sub = ?").bind(claims.sub).first<UserRow>()) ??
    (await getUserByEmail(c.env.DB, email));

  // Before auto-provisioning, so a refused network can't create accounts either.
  if (await ipRefused(c, policy, { method: "google", user, email })) return fail("ip_blocked");
  if (!user) {
    if (!policy.googleAutoProvision || !allowed.length || !domainOk) return fail("google_no_account");
    const id = await insertUser(c.env.DB, { email, name: claims.name ?? email.split("@")[0], role: "member", status: "active", googleSub: claims.sub });
    const brand = await getBrand(c.env.DB);
    if (domainOf(email) === brand.primaryDomain.toLowerCase()) {
      await ensureMailbox(c.env.DB, { address: email, displayName: claims.name ?? "", type: "personal", ownerId: id });
    }
    await audit(c, { action: "user.auto_provisioned", targetType: "user", targetId: id, actor: { id, email } });
    user = withRole(await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>())!;
  }
  const refuse = async (reason: string) => {
    await recordSignIn(c, { outcome: "failed", method: "google", user, reason });
    return fail(reason);
  };
  if (user.status === "disabled") return refuse("account_disabled");
  if (!domainOk && user.role !== "owner") return refuse("google_domain");
  if (user.google_sub && user.google_sub !== claims.sub) return refuse("google_mismatch");
  if (policy.require2fa && !user.totp_enabled) {
    const pk = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?").bind(user.id).first<{ n: number }>();
    if (needsPasskeySignIn(true, false, pk?.n ?? 0)) return refuse("passkey_required");
  }

  await c.env.DB.prepare(
    "UPDATE users SET google_sub = ?, status = 'active', name = CASE WHEN name = '' THEN ? ELSE name END, updated_at = ? WHERE id = ?",
  )
    .bind(claims.sub, claims.name ?? "", now(), user.id)
    .run();

  if (user.totp_enabled) {
    await createSession(c, user.id, { mfaPending: true });
    return c.redirect(`/login?step=2fa&next=${encodeURIComponent(data.next)}`);
  }
  await createSession(c, user.id);
  await c.env.DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(now(), user.id).run();
  await audit(c, { action: "auth.login", targetType: "user", targetId: user.id, actor: { id: user.id, email: user.email }, meta: { method: "google" } });
  await recordSignIn(c, { outcome: "success", method: "google", user });
  return c.redirect(data.next);
});
