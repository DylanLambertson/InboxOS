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
  /** May narrow a request to one user's mailboxes with `X-Act-As`. */
  canActAs: boolean;
  createdBy: string | null;
}

interface ApiKeyRow {
  id: string;
  name: string;
  scopes: string;
  mailbox_ids: string;
  can_act_as: number;
  created_by: string | null;
  last_used_at: string | null;
}

/**
 * The effective reach of one request, after an `X-Act-As` header (if any) narrows
 * the key's grants to a user's mailbox memberships.
 */
export interface RequestScope {
  /** Allowed mailbox ids, or null for "every active non-system mailbox". */
  mailboxIds: string[] | null;
  /** Mailboxes it may send from or change (acting as a read-only member can't); null = same as mailboxIds. */
  writableMailboxIds: string[] | null;
  /** Audit actor for this request: the acted-as user, or the key itself. */
  actor: { id: string; email: string };
  /** The resolved user when acting on their behalf, for `created_by` on new rows. */
  userId: string | null;
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
    .prepare("SELECT id, name, scopes, mailbox_ids, can_act_as, created_by, last_used_at FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL")
    .bind(await sha256hex(key))
    .first<ApiKeyRow>();
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    scopes: parseJson<ApiScope[]>(row.scopes, []),
    mailboxIds: parseJson<string[]>(row.mailbox_ids, []),
    canActAs: !!row.can_act_as,
    createdBy: row.created_by,
    lastUsedAt: row.last_used_at,
  };
}

/** Narrow a key's mailbox grants (empty = all) to the mailboxes a user actually belongs to. */
export function intersectMailboxes(keyMailboxIds: string[], memberMailboxIds: string[]): string[] {
  return keyMailboxIds.length ? memberMailboxIds.filter((id) => keyMailboxIds.includes(id)) : memberMailboxIds;
}

/** Resolve the request's effective scope, applying `X-Act-As` when present and permitted. */
async function resolveScope(c: Context<AppEnv>, key: ApiKey): Promise<RequestScope> {
  const actAs = c.req.header("x-act-as")?.trim().toLowerCase();
  if (!actAs) {
    const ids = key.mailboxIds.length ? key.mailboxIds : null;
    return { mailboxIds: ids, writableMailboxIds: ids, actor: keyActor(key), userId: null };
  }
  if (!key.canActAs) throw new HTTPException(403, { message: "This API key isn't allowed to act on behalf of a user." });
  const user = await c.env.DB.prepare("SELECT id, email FROM users WHERE email = ? AND status = 'active'")
    .bind(actAs)
    .first<{ id: string; email: string }>();
  // Unknown, invited (not yet onboarded) or disabled user: an empty set, so reads return
  // nothing and writes are refused — never surface mail an inactive account reaches by membership alone.
  if (!user) return { mailboxIds: [], writableMailboxIds: [], actor: keyActor(key), userId: null };
  const { results } = await c.env.DB.prepare(
    `SELECT mm.mailbox_id, mm.role FROM mailbox_members mm JOIN mailboxes m ON m.id = mm.mailbox_id
     WHERE mm.user_id = ? AND m.is_active = 1 AND m.is_system = 0`,
  )
    .bind(user.id)
    .all<{ mailbox_id: string; role: string }>();
  return {
    mailboxIds: intersectMailboxes(key.mailboxIds, results.map((r) => r.mailbox_id)),
    writableMailboxIds: intersectMailboxes(key.mailboxIds, results.filter((r) => r.role !== "viewer").map((r) => r.mailbox_id)),
    actor: { id: user.id, email: user.email },
    userId: user.id,
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
  c.set("scope", await resolveScope(c, key));
  await next();
};

export function requireScope(key: ApiKey, scope: ApiScope): void {
  if (!key.scopes.includes(scope)) {
    throw new HTTPException(403, { message: `This API key doesn't have the "${scope}" permission. An admin can issue one that does.` });
  }
}

/** Whether this request (after any `X-Act-As` narrowing) may read, or with `write` send from / change, a mailbox. */
export const mailboxAllowed = (c: Context<AppEnv>, mailboxId: string, access: "read" | "write" = "read") => {
  const scope = c.get("scope");
  const ids = access === "write" ? scope.writableMailboxIds : scope.mailboxIds;
  return ids === null || ids.includes(mailboxId);
};

/** Audit actor for requests made with a key. */
export const keyActor = (key: ApiKey) => ({ id: key.createdBy ?? key.id, email: `api-key:${key.name}` });

/** Audit actor for the current request: the acted-as user, or the key. */
export const apiActor = (c: Context<AppEnv>) => c.get("scope").actor;
