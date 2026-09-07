import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env";
import { rateLimit } from "./ratelimit";
import { newId, now, parseJson, sha256hex } from "./util";

/**
 * API keys let other services and MCP clients
 * act on the mail platform without a browser session. Keys are stored hashed and
 * limited by scope and by mailbox.
 */
export const API_SCOPES = ["send", "contacts", "read"] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export interface ApiKey {
  id: string;
  name: string;
  scopes: ApiScope[];
  /** Empty = every active mailbox. */
  mailboxIds: string[];
  createdBy: string | null;
}

interface ApiKeyRow {
  id: string;
  name: string;
  scopes: string;
  mailbox_ids: string;
  created_by: string | null;
  last_used_at: string | null;
}

const KEY_PREFIX = "io_";

export async function generateKey(): Promise<{ key: string; hash: string; prefix: string }> {
  const key = KEY_PREFIX + newId(32);
  return { key, hash: await sha256hex(key), prefix: key.slice(0, 10) };
}

/** Authorization: Bearer <key>, or the key as a URL path segment (for MCP clients that can't set headers). */
function presentedKey(c: Context<AppEnv>): string | null {
  const auth = c.req.header("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(\S+)$/i);
  if (m) return m[1];
  return c.req.param("key") ?? null;
}

export async function findKey(db: D1Database, key: string): Promise<(ApiKey & { lastUsedAt: string | null }) | null> {
  if (!key.startsWith(KEY_PREFIX) || key.length > 100) return null;
  const row = await db
    .prepare("SELECT id, name, scopes, mailbox_ids, created_by, last_used_at FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL")
    .bind(await sha256hex(key))
    .first<ApiKeyRow>();
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    scopes: parseJson<ApiScope[]>(row.scopes, []),
    mailboxIds: parseJson<string[]>(row.mailbox_ids, []),
    createdBy: row.created_by,
    lastUsedAt: row.last_used_at,
  };
}

/** Authenticates the request by API key and puts it on the context as `apiKey`. */
export const requireApiKey: MiddlewareHandler<AppEnv> = async (c, next) => {
  const presented = presentedKey(c);
  const key = presented ? await findKey(c.env.DB, presented) : null;
  if (!key) throw new HTTPException(401, { message: "Missing or invalid API key" });
  if (!(await rateLimit(c.env.DB, `api:${key.id}`, 240, 60))) {
    throw new HTTPException(429, { message: "Too many requests for this API key. Slow down and retry in a minute." });
  }
  if (!key.lastUsedAt || Date.now() - Date.parse(key.lastUsedAt) > 5 * 60_000) {
    c.executionCtx.waitUntil(c.env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(now(), key.id).run());
  }
  c.set("apiKey", key);
  await next();
};

export function requireScope(key: ApiKey, scope: ApiScope): void {
  if (!key.scopes.includes(scope)) {
    throw new HTTPException(403, { message: `This API key doesn't have the "${scope}" permission. An admin can issue one that does.` });
  }
}

export const keyAllowsMailbox = (key: ApiKey, mailboxId: string) => !key.mailboxIds.length || key.mailboxIds.includes(mailboxId);

/** Audit actor for requests made with a key. */
export const keyActor = (key: ApiKey) => ({ id: key.createdBy ?? key.id, email: `api-key:${key.name}` });
