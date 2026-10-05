import type { Env } from "../env";
import { maskSecret, openSecret, sealSecret } from "./secret-box";
import { now } from "./util";

/**
 * Email provider credentials. Environment variables (Worker secrets) win when set;
 * otherwise the values entered in the setup wizard are used, decrypted from the
 * `secrets` table. Reads are cached briefly per isolate and dropped on every change.
 */
export const SECRET_NAMES = {
  apiKey: "resend.api_key",
  webhookSecret: "resend.webhook_secret",
} as const;
export type CredentialKind = keyof typeof SECRET_NAMES;

const ENV_NAME: Record<CredentialKind, "RESEND_API_KEY" | "RESEND_WEBHOOK_SECRET"> = {
  apiKey: "RESEND_API_KEY",
  webhookSecret: "RESEND_WEBHOOK_SECRET",
};

interface StoredRow {
  value: string;
  updated_at: string;
  updated_by: string | null;
}
interface CacheEntry {
  at: number;
  row: StoredRow | null;
  /** Decrypted value; null when there's no row or it can't be opened. */
  plain: string | null;
}

const TTL = 15_000;
const cache = new Map<string, CacheEntry>();

/** Forget cached credentials (after a change, or in tests). */
export function invalidateProviderConfig() {
  cache.clear();
}

async function readStored(env: Env, kind: CredentialKind): Promise<CacheEntry> {
  const name = SECRET_NAMES[kind];
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < TTL) return hit;
  let row: StoredRow | null = null;
  try {
    row = await env.DB.prepare("SELECT value, updated_at, updated_by FROM secrets WHERE name = ?").bind(name).first<StoredRow>();
  } catch (err) {
    // Before migration 0019 runs there is no table: behave as if nothing is stored.
    console.error("could not read stored credentials", err);
  }
  const plain = row ? await openSecret(env.SESSION_SECRET, name, row.value) : null;
  const entry = { at: Date.now(), row, plain };
  cache.set(name, entry);
  return entry;
}

async function resolve(env: Env, kind: CredentialKind): Promise<string | undefined> {
  const fromEnv = env[ENV_NAME[kind]];
  if (fromEnv) return fromEnv;
  return (await readStored(env, kind)).plain ?? undefined;
}

/** The Resend API key to use, or undefined when none is configured. */
export const getResendApiKey = (env: Env) => resolve(env, "apiKey");
/** The webhook signing secret (whsec_…), or undefined when none is configured. */
export const getWebhookSecret = (env: Env) => resolve(env, "webhookSecret");

export interface CredentialStatus {
  configured: boolean;
  /** "env" = a Worker secret (can't be changed here), "app" = entered in the app. */
  source: "env" | "app" | null;
  masked: string | null;
  updatedAt: string | null;
  /** A stored value exists but can't be decrypted (SESSION_SECRET changed): enter it again. */
  unreadable: boolean;
}

export async function credentialStatus(env: Env, kind: CredentialKind): Promise<CredentialStatus> {
  const fromEnv = env[ENV_NAME[kind]];
  if (fromEnv) return { configured: true, source: "env", masked: maskSecret(fromEnv), updatedAt: null, unreadable: false };
  const s = await readStored(env, kind);
  if (!s.row) return { configured: false, source: null, masked: null, updatedAt: null, unreadable: false };
  return {
    configured: !!s.plain,
    source: "app",
    masked: s.plain ? maskSecret(s.plain) : null,
    updatedAt: s.row.updated_at,
    unreadable: !s.plain,
  };
}

export async function providerStatus(env: Env) {
  const [apiKey, webhookSecret] = await Promise.all([credentialStatus(env, "apiKey"), credentialStatus(env, "webhookSecret")]);
  return { apiKey, webhookSecret };
}

/** Encrypt and store a credential entered in the app. */
export async function storeCredential(env: Env, kind: CredentialKind, value: string, userId: string | null): Promise<void> {
  const name = SECRET_NAMES[kind];
  const sealed = await sealSecret(env.SESSION_SECRET, name, value);
  await env.DB.prepare(
    `INSERT INTO secrets (name, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(name) DO UPDATE SET value = ?2, updated_at = ?3, updated_by = ?4`,
  )
    .bind(name, sealed, now(), userId)
    .run();
  invalidateProviderConfig();
}

/** Remove a stored credential. Returns whether one existed. */
export async function clearCredential(env: Env, kind: CredentialKind): Promise<boolean> {
  const res = await env.DB.prepare("DELETE FROM secrets WHERE name = ?").bind(SECRET_NAMES[kind]).run();
  invalidateProviderConfig();
  return !!res.meta.changes;
}

/** True when the value comes from a Worker secret, which the app can't change. */
export const isFromEnv = (env: Env, kind: CredentialKind) => !!env[ENV_NAME[kind]];
