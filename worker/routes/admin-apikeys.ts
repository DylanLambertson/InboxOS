import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../env";
import { API_SCOPES, generateKey } from "../lib/apikeys";
import { audit } from "../lib/audit";
import { newId, now, parseJson } from "../lib/util";
import { parseBody, zId } from "../lib/validate";

/** Admin → API & MCP: issue and revoke API keys, and manage the do-not-email list. */
export const adminApiKeyRoutes = new Hono<AppEnv>();

adminApiKeyRoutes.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT k.id, k.name, k.prefix, k.scopes, k.mailbox_ids, k.can_act_as, k.last_used_at, k.revoked_at, k.created_at, u.name AS created_by_name, u.email AS created_by_email
     FROM api_keys k LEFT JOIN users u ON u.id = k.created_by ORDER BY k.revoked_at IS NOT NULL, k.created_at DESC`,
  ).all<Record<string, string | number | null>>();
  return c.json(
    results.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      scopes: parseJson<string[]>(r.scopes as string, []),
      mailboxIds: parseJson<string[]>(r.mailbox_ids as string, []),
      canActAs: !!r.can_act_as,
      lastUsedAt: r.last_used_at,
      revokedAt: r.revoked_at,
      createdAt: r.created_at,
      createdBy: r.created_by_name || r.created_by_email,
    })),
  );
});

adminApiKeyRoutes.post("/", async (c) => {
  const body = await parseBody(
    c,
    z.object({
      name: z.string().trim().min(1).max(80),
      scopes: z.array(z.enum(API_SCOPES)).min(1),
      mailboxIds: z.array(zId).max(200).default([]),
      canActAs: z.boolean().default(false),
    }),
  );
  if (body.mailboxIds.length) {
    const { results } = await c.env.DB.prepare(`SELECT id FROM mailboxes WHERE is_system = 0 AND id IN (${body.mailboxIds.map(() => "?").join(",")})`)
      .bind(...body.mailboxIds)
      .all<{ id: string }>();
    if (results.length !== new Set(body.mailboxIds).size) throw new HTTPException(400, { message: "Unknown mailbox" });
  }
  const { key, hash, prefix } = await generateKey();
  const id = newId();
  await c.env.DB.prepare(
    "INSERT INTO api_keys (id, name, key_hash, prefix, scopes, mailbox_ids, can_act_as, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, body.name, hash, prefix, JSON.stringify([...new Set(body.scopes)]), JSON.stringify([...new Set(body.mailboxIds)]), body.canActAs ? 1 : 0, c.get("user").id, now())
    .run();
  await audit(c, { action: "api_key.created", targetType: "api_key", targetId: id, meta: { name: body.name, scopes: body.scopes, mailboxes: body.mailboxIds.length || "all", canActAs: body.canActAs } });
  // The key itself is only ever returned here.
  return c.json({ id, key }, 201);
});

adminApiKeyRoutes.delete("/:id", async (c) => {
  const res = await c.env.DB.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now(), c.req.param("id")).run();
  if (!res.meta.changes) throw new HTTPException(404, { message: "Key not found or already revoked" });
  await audit(c, { action: "api_key.revoked", targetType: "api_key", targetId: c.req.param("id") });
  return c.json({ ok: true });
});

// ---- Do-not-email list ------------------------------------------------------

export const adminSuppressionRoutes = new Hono<AppEnv>();

adminSuppressionRoutes.get("/", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT email, reason, detail, created_at AS createdAt FROM suppressions ORDER BY created_at DESC LIMIT 500").all();
  return c.json(results);
});

adminSuppressionRoutes.delete("/:email", async (c) => {
  const email = c.req.param("email").toLowerCase();
  const res = await c.env.DB.prepare("DELETE FROM suppressions WHERE email = ?").bind(email).run();
  if (!res.meta.changes) throw new HTTPException(404, { message: "Not on the list" });
  await audit(c, { action: "suppression.removed", targetType: "contact", targetId: email });
  return c.json({ ok: true });
});
