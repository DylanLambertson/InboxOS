import { mailDomains } from "@shared/brand";
import { deriveSteps, isSetupStep, nextStep, setupProgress, type PublicSetupStatus, type SetupFacts, type SetupStepId } from "@shared/setup";
import type { Env } from "../env";
import { getResendApiKey, getWebhookSecret } from "./provider-config";
import { storedRole } from "./roles";
import { getBrand } from "./settings";
import { newId, now, parseJson, randomColor, sha256hex, timingSafeEqual } from "./util";

/**
 * First-run setup: the saved progress (settings key "setup"), the setup-key check that
 * guards creating the first owner, and the facts each step's completion is derived from.
 */

export interface DomainCacheEntry {
  id: string;
  status: string;
  region: string;
  receiving: boolean;
  checkedAt: string;
}

export interface SetupTestState {
  /** Test message to an outside address. */
  send?: { to: string; from: string; resendId: string | null; at: string; error?: string };
  /** Loopback: a message from a mailbox to itself, which must come back through the webhook. */
  loopback?: { token: string; mailboxId: string; address: string; resendId: string | null; at: string; receivedAt?: string; error?: string };
}

export interface SetupState {
  completedAt: string | null;
  /** The owner hid the "finish setup" banner. */
  dismissedAt: string | null;
  skipped: SetupStepId[];
  /** Last known provider status of each mail domain, refreshed whenever an admin looks. */
  domains: Record<string, DomainCacheEntry>;
  /** The webhook registered with the provider (secret is in the secrets table). */
  webhook: { id: string | null; endpoint: string; source: "auto" | "manual"; at: string } | null;
  test: SetupTestState;
}

export const EMPTY_SETUP: SetupState = { completedAt: null, dismissedAt: null, skipped: [], domains: {}, webhook: null, test: {} };

/** Coerce a stored value into a valid state. */
export function sanitizeSetupState(raw: unknown): SetupState {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<SetupState>;
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    completedAt: s(r.completedAt),
    dismissedAt: s(r.dismissedAt),
    skipped: Array.isArray(r.skipped) ? [...new Set(r.skipped.filter(isSetupStep))] : [],
    domains: r.domains && typeof r.domains === "object" ? r.domains : {},
    webhook: r.webhook && typeof r.webhook === "object" && typeof r.webhook.endpoint === "string" ? r.webhook : null,
    test: r.test && typeof r.test === "object" ? r.test : {},
  };
}

export async function loadSetupState(db: D1Database): Promise<SetupState> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'setup'").first<{ value: string }>();
  return sanitizeSetupState(parseJson<unknown>(row?.value, {}));
}

/** Read, change and save the state. Returns the saved state. */
export async function updateSetupState(db: D1Database, userId: string | null, change: (s: SetupState) => SetupState | void): Promise<SetupState> {
  const current = await loadSetupState(db);
  const next = sanitizeSetupState(change(current) ?? current);
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('setup', ?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = ?1, updated_at = ?2, updated_by = ?3`,
    )
    .bind(JSON.stringify(next), now(), userId)
    .run();
  return next;
}

// ---- Setup key --------------------------------------------------------------

/** Where the setup key comes from: SETUP_TOKEN if set, otherwise SESSION_SECRET. */
export const setupKeySource = (env: Pick<Env, "SETUP_TOKEN">): PublicSetupStatus["setupKeySource"] => (env.SETUP_TOKEN ? "SETUP_TOKEN" : "SESSION_SECRET");

/**
 * Constant-time check of the setup key. Both sides are hashed first so the comparison
 * takes the same time whatever the lengths; surrounding whitespace from a paste is ignored.
 */
export async function setupKeyMatches(env: Pick<Env, "SETUP_TOKEN" | "SESSION_SECRET">, provided: string): Promise<boolean> {
  const expected = (env.SETUP_TOKEN || env.SESSION_SECRET || "").trim();
  const given = (provided ?? "").trim();
  if (!expected || !given) return false;
  const [a, b] = await Promise.all([sha256hex(given), sha256hex(expected)]);
  return timingSafeEqual(a, b);
}

// ---- First owner ------------------------------------------------------------

/**
 * Create the first owner, but only while there are no users at all. A single
 * INSERT … WHERE NOT EXISTS is atomic, so two simultaneous requests can't both
 * succeed. Returns the new id, or null when someone got there first.
 */
export async function createFirstOwner(db: D1Database, u: { email: string; name: string; passwordHash: string }): Promise<string | null> {
  const id = newId();
  const t = now();
  const stored = storedRole("owner");
  const res = await db
    .prepare(
      `INSERT INTO users (id, email, name, password_hash, role, is_manager, status, avatar_color, created_at, updated_at, last_login_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?8, ?8, ?8
       WHERE NOT EXISTS (SELECT 1 FROM users)`,
    )
    .bind(id, u.email.trim().toLowerCase(), u.name.trim(), u.passwordHash, stored.role, stored.isManager, randomColor(), t)
    .run();
  return res.meta.changes ? id : null;
}

// ---- Status -----------------------------------------------------------------

export async function loadSetupFacts(env: Env, state?: SetupState): Promise<SetupFacts> {
  const db = env.DB;
  const [s, counts, workspaceRow, brand, apiKey, webhookSecret] = await Promise.all([
    state ?? loadSetupState(db),
    db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM users) AS users,
           (SELECT COUNT(*) FROM users WHERE role = 'owner' AND status = 'active') AS owners,
           (SELECT COUNT(*) FROM mailboxes WHERE is_active = 1 AND is_system = 0) AS mailboxes`,
      )
      .first<{ users: number; owners: number; mailboxes: number }>(),
    db.prepare("SELECT 1 AS ok FROM settings WHERE key = 'workspace'").first(),
    getBrand(db),
    getResendApiKey(env),
    getWebhookSecret(env),
  ]);
  return {
    ownerExists: (counts?.owners ?? 0) > 0,
    useCaseChosen: !!workspaceRow,
    brandNamed: !!brand.companyName.trim(),
    apiKeyConfigured: !!apiKey,
    primaryDomain: brand.primaryDomain,
    domains: mailDomains(brand).map((name) => ({ name, status: s.domains[name]?.status ?? null })),
    webhookConfigured: !!webhookSecret,
    mailboxCount: counts?.mailboxes ?? 0,
    userCount: counts?.users ?? 0,
    testPassed: !!s.test.loopback?.receivedAt || (!!s.test.send?.resendId && !s.test.send.error),
    completedAt: s.completedAt,
    skipped: s.skipped,
  };
}

export async function publicSetupStatus(env: Env): Promise<PublicSetupStatus> {
  const state = await loadSetupState(env.DB);
  const facts = await loadSetupFacts(env, state);
  const steps = deriveSteps(facts);
  return {
    ownerExists: facts.ownerExists,
    completed: !!facts.completedAt,
    dismissed: !!state.dismissedAt,
    steps,
    nextStep: nextStep(steps),
    progress: setupProgress(steps),
    setupKeySource: setupKeySource(env),
  };
}

/** Why the provider can't reach this app's webhook URL, or null when it looks reachable. */
export function webhookUrlProblem(appUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(appUrl);
  } catch {
    return "APP_URL isn't a valid URL. Set it in wrangler.jsonc to the address people use to open the app.";
  }
  if (u.protocol !== "https:") return `APP_URL is ${u.origin}. Resend can only deliver webhooks to a public https:// address, so set APP_URL to your deployed URL.`;
  if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(u.hostname) || u.hostname.endsWith(".local")) {
    return `APP_URL points at ${u.hostname}, which Resend can't reach. Set it to your deployed URL.`;
  }
  return null;
}

export const webhookEndpoint = (appUrl: string) => `${appUrl.replace(/\/$/, "")}/webhooks/resend`;
