import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireFeature, WRITES } from "../lib/features";
import { audit } from "../lib/audit";
import { generateScimToken, getScimSettings, saveScimSettings } from "../lib/scim-auth";
import { newId, now } from "../lib/util";
import { parseBody } from "../lib/validate";

/** Admin → Provisioning: the SCIM token, onboarding options and recent SCIM activity. */
export const adminScimRoutes = new Hono<AppEnv>();
// New tokens and settings need provisioning on; revoking a token always works.
adminScimRoutes.use("*", requireFeature("provisioning", { methods: WRITES }));

adminScimRoutes.get("/", async (c) => {
  const db = c.env.DB;
  const [token, settings, activity, counts] = await Promise.all([
    db
      .prepare(
        `SELECT t.prefix, t.created_at, t.last_used_at, u.name AS created_by_name, u.email AS created_by_email
         FROM scim_tokens t LEFT JOIN users u ON u.id = t.created_by WHERE t.revoked_at IS NULL ORDER BY t.created_at DESC LIMIT 1`,
      )
      .first<{ prefix: string; created_at: string; last_used_at: string | null; created_by_name: string | null; created_by_email: string | null }>(),
    getScimSettings(db),
    db
      .prepare("SELECT id, created_at, action, target_id, meta FROM audit_logs WHERE actor_email = 'scim' ORDER BY created_at DESC LIMIT 25")
      .all<{ id: string; created_at: string; action: string; target_id: string | null; meta: string }>(),
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE scim_external_id IS NOT NULL").first<{ n: number }>(),
  ]);
  return c.json({
    baseUrl: `${c.env.APP_URL.replace(/\/$/, "")}/scim/v2`,
    token: token
      ? { prefix: token.prefix, createdAt: token.created_at, lastUsedAt: token.last_used_at, createdBy: token.created_by_name || token.created_by_email }
      : null,
    settings,
    // Last change pushed by the identity provider (reads only touch the token's last-used time).
    lastSyncAt: activity.results[0]?.created_at ?? null,
    linkedUsers: counts?.n ?? 0,
    activity: activity.results.map((r) => {
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(r.meta);
      } catch {
        /* keep empty */
      }
      return { id: r.id, at: r.created_at, action: r.action, userId: r.target_id, email: typeof meta.email === "string" ? meta.email : null };
    }),
  });
});

/** Issue a new token, revoking any existing one. The token is only ever returned here. */
adminScimRoutes.post("/token", async (c) => {
  const { token, hash, prefix } = await generateScimToken();
  const id = newId();
  const t = now();
  const res = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE scim_tokens SET revoked_at = ? WHERE revoked_at IS NULL").bind(t),
    c.env.DB.prepare("INSERT INTO scim_tokens (id, token_hash, prefix, created_by, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, hash, prefix, c.get("user").id, t),
  ]);
  await audit(c, { action: res[0].meta.changes ? "scim.token_rotated" : "scim.token_created", targetType: "scim_token", targetId: id });
  return c.json({ token }, 201);
});

/** Turn provisioning off: the identity provider's calls fail until a new token is issued. */
adminScimRoutes.delete("/token", async (c) => {
  const res = await c.env.DB.prepare("UPDATE scim_tokens SET revoked_at = ? WHERE revoked_at IS NULL").bind(now()).run();
  if (!res.meta.changes) throw new HTTPException(404, { message: "There's no active SCIM token." });
  await audit(c, { action: "scim.token_revoked", targetType: "scim_token" });
  return c.json({ ok: true });
});

adminScimRoutes.put("/settings", async (c) => {
  const body = await parseBody(c, z.object({ createMailbox: z.boolean(), onboarding: z.enum(["sso", "invite"]) }));
  const before = await getScimSettings(c.env.DB);
  await saveScimSettings(c.env.DB, body, c.get("user").id);
  await audit(c, { action: "scim.settings_updated", targetType: "settings", meta: { from: before, to: body } });
  return c.json(body);
});
