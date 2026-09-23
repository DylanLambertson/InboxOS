import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env";
import { audit } from "../lib/audit";
import { describeDevice } from "../lib/email-templates";
import { ipAllowed } from "../lib/ip-allowlist";
import { roleSql } from "../lib/roles";
import { likeEscape } from "../lib/search";
import { getPolicy } from "../lib/settings";
import { allowlistIp } from "../lib/sign-ins";
import { clampInt, now } from "../lib/util";

/** Admin → Security: org-wide sessions, sign-in history and the network the admin is on. */
export const adminSecurityRoutes = new Hono<AppEnv>();

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const DAY = 86_400_000;
const isHandle = (h: string) => /^[0-9a-f]{16}$/.test(h);
const isId = (s: string) => /^[A-Za-z0-9_-]{1,64}$/.test(s);
const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

interface SessionRow {
  id: string;
  user_id: string;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
  email: string;
  name: string;
  role: string;
}

adminSecurityRoutes.get("/sessions", async (c) => {
  const q = (c.req.query("q") ?? "").trim().slice(0, 200);
  const user = c.req.query("user") ?? "";
  if (user && !isId(user)) throw new HTTPException(400, { message: "Invalid user" });
  const pat = `%${likeEscape(q)}%`;
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.user_id, s.ip, s.user_agent, s.created_at, s.last_seen_at, u.email, u.name, ${roleSql("u")} AS role
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.mfa_pending = 0 AND s.expires_at > ?1 AND u.status = 'active'
       AND (?2 = '' OR u.email LIKE ?3 ESCAPE '\\' OR u.name LIKE ?3 ESCAPE '\\' OR s.ip LIKE ?3 ESCAPE '\\' OR s.user_agent LIKE ?3 ESCAPE '\\')
       AND (?4 = '' OR s.user_id = ?4)
     ORDER BY s.last_seen_at DESC LIMIT 500`,
  )
    .bind(now(), q, pat, user)
    .all<SessionRow>();
  const me = c.get("user");
  // Session ids are token hashes; only a short opaque handle leaves the server.
  return c.json(
    results.map((s) => ({
      id: s.id.slice(0, 16),
      userId: s.user_id,
      email: s.email,
      name: s.name,
      role: s.role,
      ip: s.ip,
      device: describeDevice(s.user_agent),
      userAgent: s.user_agent,
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      current: s.id === me.sessionId,
    })),
  );
});

/** Only owners may sign owners out, matching who may manage owners elsewhere. */
function assertMayManage(c: Context<AppEnv>, targetRole: string) {
  if (targetRole === "owner" && c.get("user").role !== "owner") {
    throw new HTTPException(403, { message: "Only owners can sign out an owner." });
  }
}

adminSecurityRoutes.delete("/sessions/:handle", async (c) => {
  const handle = c.req.param("handle");
  if (!isHandle(handle)) throw new HTTPException(400, { message: "Invalid session" });
  const s = await c.env.DB.prepare(
    `SELECT s.id, s.user_id, s.ip, s.user_agent, u.email, ${roleSql("u")} AS role
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE substr(s.id, 1, 16) = ? LIMIT 1`,
  )
    .bind(handle)
    .first<SessionRow>();
  if (!s) throw new HTTPException(404, { message: "That session has already ended." });
  if (s.id === c.get("user").sessionId) throw new HTTPException(400, { message: "That's your current session. Use Sign out instead." });
  assertMayManage(c, s.role);
  await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(s.id).run();
  await audit(c, {
    action: "admin.session_revoked",
    targetType: "user",
    targetId: s.user_id,
    meta: { email: s.email, session: handle, ip: s.ip, device: describeDevice(s.user_agent) },
  });
  return c.json({ ok: true });
});

adminSecurityRoutes.post("/users/:id/revoke-sessions", async (c) => {
  const id = c.req.param("id");
  if (!isId(id)) throw new HTTPException(400, { message: "Invalid user" });
  const target = await c.env.DB.prepare(`SELECT u.id, u.email, ${roleSql("u")} AS role FROM users u WHERE u.id = ?`)
    .bind(id)
    .first<{ id: string; email: string; role: string }>();
  if (!target) throw new HTTPException(404, { message: "User not found" });
  assertMayManage(c, target.role);
  // An admin signing themselves out everywhere keeps the session they're using.
  const res = await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").bind(id, c.get("user").sessionId).run();
  const count = res.meta.changes ?? 0;
  await audit(c, { action: "admin.sessions_revoked", targetType: "user", targetId: id, meta: { email: target.email, count } });
  return c.json({ ok: true, count });
});

adminSecurityRoutes.get("/sign-ins", async (c) => {
  const user = c.req.query("user") ?? "";
  const q = (c.req.query("q") ?? "").trim().slice(0, 200);
  const failed = c.req.query("failed") === "1" ? 1 : 0;
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") ?? "";
  const cursor = c.req.query("cursor") ?? "";
  if (user && !isId(user)) throw new HTTPException(400, { message: "Invalid user" });
  if ((from && !isDay(from)) || (to && !isDay(to))) throw new HTTPException(400, { message: "Dates must look like 2026-01-31" });
  if (cursor && Number.isNaN(Date.parse(cursor))) throw new HTTPException(400, { message: "Invalid cursor" });
  const limit = clampInt(c.req.query("limit"), 1, 200, 50);
  // "to" is a whole day, so the bound is the start of the next one.
  const toBound = to ? new Date(Date.parse(to) + DAY).toISOString() : "";
  const fromBound = from ? new Date(Date.parse(from)).toISOString() : "";
  const pat = `%${likeEscape(q)}%`;
  const { results } = await c.env.DB.prepare(
    `SELECT id, created_at, user_id, email, outcome, method, reason, ip, device, country, user_agent FROM login_events
     WHERE (?1 = '' OR user_id = ?1)
       AND (?2 = 0 OR outcome != 'success')
       AND (?3 = '' OR created_at >= ?3)
       AND (?4 = '' OR created_at < ?4)
       AND (?5 = '' OR created_at < ?5)
       AND (?6 = '' OR email LIKE ?7 ESCAPE '\\' OR ip LIKE ?7 ESCAPE '\\' OR country = upper(?6) OR device LIKE ?7 ESCAPE '\\')
     ORDER BY created_at DESC LIMIT ?8`,
  )
    .bind(user, failed, fromBound, toBound, cursor, q, pat, limit + 1)
    .all<Record<string, unknown> & { created_at: string }>();
  const page = results.slice(0, limit);
  return c.json({ items: page, nextCursor: results.length > limit ? page[page.length - 1].created_at : null });
});

adminSecurityRoutes.get("/stats", async (c) => {
  const day = ago(DAY);
  const month = ago(30 * DAY);
  const [counts, { results: countries }] = await Promise.all([
    c.env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM login_events WHERE outcome != 'success' AND created_at >= ?1) AS failed24h,
         (SELECT COUNT(*) FROM login_events WHERE outcome = 'blocked' AND created_at >= ?1) AS blocked24h,
         (SELECT COUNT(*) FROM login_events WHERE outcome = 'success' AND created_at >= ?1) AS signIns24h,
         (SELECT COUNT(DISTINCT country) FROM login_events WHERE outcome = 'success' AND country IS NOT NULL AND created_at >= ?2) AS countries30d,
         (SELECT COUNT(*) FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.mfa_pending = 0 AND s.expires_at > ?3 AND u.status = 'active') AS activeSessions`,
    )
      .bind(day, month, now())
      .first<Record<string, number>>(),
    c.env.DB.prepare(
      `SELECT country, COUNT(*) AS n FROM login_events WHERE outcome = 'success' AND country IS NOT NULL AND created_at >= ?
       GROUP BY country ORDER BY n DESC LIMIT 20`,
    )
      .bind(month)
      .all<{ country: string; n: number }>(),
  ]);
  return c.json({ ...counts, countries });
});

/** The address the allowlist sees for this admin, so they can add their own network safely. */
adminSecurityRoutes.get("/network", async (c) => {
  const policy = await getPolicy(c.env.DB);
  const ip = allowlistIp(c);
  return c.json({ ip, insideAllowlist: ipAllowed(ip, policy.ipAllowlist) });
});
