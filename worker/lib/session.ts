import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, Env, SessionUser } from "../env";
import type { Role } from "@shared/types";
import { clientIp } from "./audit";
import { getPolicy } from "./settings";
import { newId, now, sha256hex } from "./util";

const TOUCH_INTERVAL_MS = 5 * 60_000;

export function cookieName(env: Env): string {
  return isSecure(env) ? "__Host-session" : "session";
}
const isSecure = (env: Env) => env.APP_URL?.startsWith("https://") ?? false;

export async function createSession(
  c: Context<AppEnv>,
  userId: string,
  opts: { mfaPending?: boolean } = {},
): Promise<void> {
  const policy = await getPolicy(c.env.DB);
  const token = newId(32);
  const id = await sha256hex(token);
  const ttlMs = opts.mfaPending ? 10 * 60_000 : policy.sessionDays * 86_400_000;
  const t = now();
  await c.env.DB.prepare(
    `INSERT INTO sessions (id, user_id, mfa_pending, ip, user_agent, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      userId,
      opts.mfaPending ? 1 : 0,
      clientIp(c),
      c.req.header("user-agent")?.slice(0, 300) ?? null,
      t,
      t,
      new Date(Date.now() + ttlMs).toISOString(),
    )
    .run();
  setCookie(c, cookieName(c.env), token, {
    httpOnly: true,
    secure: isSecure(c.env),
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(ttlMs / 1000),
  });
}

export async function destroySession(c: Context<AppEnv>): Promise<void> {
  const token = getCookie(c, cookieName(c.env));
  if (token) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(await sha256hex(token)).run();
  }
  deleteCookie(c, cookieName(c.env), { path: "/", secure: isSecure(c.env) });
}

interface SessionRow {
  sid: string;
  mfa_pending: number;
  last_seen_at: string;
  expires_at: string;
  id: string;
  email: string;
  name: string;
  role: Role;
  status: string;
}

/** Resolve the session cookie. `allowMfaPending` lets the 2FA step read a half-authenticated session. */
export async function readSession(c: Context<AppEnv>, allowMfaPending = false): Promise<SessionRow | null> {
  const token = getCookie(c, cookieName(c.env));
  if (!token) return null;
  const sid = await sha256hex(token);
  const row = await c.env.DB.prepare(
    `SELECT s.id AS sid, s.mfa_pending, s.last_seen_at, s.expires_at, u.id, u.email, u.name, u.role, u.status
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
  )
    .bind(sid)
    .first<SessionRow>();
  if (!row) return null;
  if (row.expires_at < now() || row.status !== "active") {
    await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sid).run();
    return null;
  }
  if (row.mfa_pending && !allowMfaPending) return null;
  return row;
}

/** Requires a fully authenticated session and puts the user on the context. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const row = await readSession(c);
  if (!row) throw new HTTPException(401, { message: "Not signed in" });
  const user: SessionUser = { id: row.id, email: row.email, name: row.name, role: row.role, sessionId: row.sid };
  c.set("user", user);
  if (Date.now() - Date.parse(row.last_seen_at) > TOUCH_INTERVAL_MS) {
    const policy = await getPolicy(c.env.DB);
    c.executionCtx.waitUntil(
      c.env.DB.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?")
        .bind(now(), new Date(Date.now() + policy.sessionDays * 86_400_000).toISOString(), row.sid)
        .run(),
    );
  }
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const u = c.get("user");
  if (u.role !== "owner" && u.role !== "admin") throw new HTTPException(403, { message: "Admins only" });
  await next();
};

export const isAdmin = (u: SessionUser) => u.role === "owner" || u.role === "admin";

/**
 * CSRF defence for cookie auth: state-changing requests must come from our own origin.
 * Browsers always send Origin (or Sec-Fetch-Site) on cross-site POST/PUT/PATCH/DELETE.
 */
export const sameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const site = c.req.header("sec-fetch-site");
    const origin = c.req.header("origin");
    const self = new URL(c.req.url).origin;
    const ok = site ? site === "same-origin" || site === "none" : !origin || origin === self;
    if (!ok) throw new HTTPException(403, { message: "Cross-site request blocked" });
  }
  await next();
};
