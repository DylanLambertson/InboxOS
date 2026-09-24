import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { clientIp } from "./audit";
import { rateLimit } from "./ratelimit";
import { ScimError } from "./scim";
import { newId, now, parseJson, sha256hex, timingSafeEqual } from "./util";

/**
 * The SCIM bearer token. Separate from API keys because it can create and deactivate accounts,
 * which no API key can. One active token at a time; rotating revokes the old one.
 */
const TOKEN_PREFIX = "scim_";

export async function generateScimToken(): Promise<{ token: string; hash: string; prefix: string }> {
  const token = TOKEN_PREFIX + newId(32);
  return { token, hash: await sha256hex(token), prefix: token.slice(0, 10) };
}

export interface ScimSettings {
  /** Give each provisioned user a personal mailbox at <local part>@<primary domain>. */
  createMailbox: boolean;
  /** "sso": active right away, signs in with Google. "invite": emailed an invite link to set a password. */
  onboarding: "sso" | "invite";
}
export const DEFAULT_SCIM_SETTINGS: ScimSettings = { createMailbox: true, onboarding: "sso" };

export async function getScimSettings(db: D1Database): Promise<ScimSettings> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'scim'").first<{ value: string }>();
  return { ...DEFAULT_SCIM_SETTINGS, ...parseJson<Partial<ScimSettings>>(row?.value, {}) };
}

export async function saveScimSettings(db: D1Database, value: ScimSettings, userId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('scim', ?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = ?1, updated_at = ?2, updated_by = ?3`,
    )
    .bind(JSON.stringify(value), now(), userId)
    .run();
}

/** Authenticates SCIM requests by bearer token, rate-limited per token. */
export const requireScimToken: MiddlewareHandler<AppEnv> = async (c, next) => {
  const m = (c.req.header("authorization") ?? "").match(/^Bearer\s+(\S{1,200})$/i);
  const presented = m?.[1];
  let tokenId: string | null = null;
  let lastUsedAt: string | null = null;
  if (presented?.startsWith(TOKEN_PREFIX)) {
    const hash = await sha256hex(presented);
    // Compare every live token's hash in constant time rather than looking the hash up by index.
    const { results } = await c.env.DB.prepare("SELECT id, token_hash, last_used_at FROM scim_tokens WHERE revoked_at IS NULL").all<{
      id: string;
      token_hash: string;
      last_used_at: string | null;
    }>();
    for (const r of results) {
      if (timingSafeEqual(r.token_hash, hash)) {
        tokenId = r.id;
        lastUsedAt = r.last_used_at;
      }
    }
  }
  if (!tokenId) {
    // Slow down guessing from one address.
    if (!(await rateLimit(c.env.DB, `scim-auth:${clientIp(c) ?? "unknown"}`, 30, 60))) throw new ScimError(429, "Too many failed attempts. Retry in a minute.");
    throw new ScimError(401, "Missing or invalid SCIM token");
  }
  if (!(await rateLimit(c.env.DB, `scim:${tokenId}`, 600, 60))) throw new ScimError(429, "Too many requests. Retry in a minute.");
  if (!lastUsedAt || Date.now() - Date.parse(lastUsedAt) > 60_000) {
    c.executionCtx.waitUntil(c.env.DB.prepare("UPDATE scim_tokens SET last_used_at = ? WHERE id = ?").bind(now(), tokenId).run());
  }
  c.set("scimTokenId", tokenId);
  await next();
};
