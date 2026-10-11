import { Hono, type Context } from "hono";
import type { HealthReport } from "@shared/health";
import { mailDomains } from "@shared/brand";
import type { AppEnv, Env } from "../env";
import { evaluateHealth, summarize, type HealthSnapshot, type ProviderKeyCheck } from "../lib/health-checks";
import { lastCronRun } from "../lib/heartbeat";
import { webhookHealth } from "../lib/webhooks";
import { ipAllowed } from "../lib/ip-allowlist";
import { getResendApiKey, getWebhookSecret } from "../lib/provider-config";
import { resend, ResendError } from "../lib/resend";
import { quotaUsage } from "../lib/send";
import { loadSettings } from "../lib/settings";
import { allowlistIp } from "../lib/sign-ins";

export const adminHealthRoutes = new Hono<AppEnv>();

/** The email provider's API key: the Worker secret, or the key saved in the setup wizard. */
export const providerApiKey = (env: Env): Promise<string | undefined> => getResendApiKey(env);

const TIMEOUT_MS = 5_000;

/** List domains with a short timeout: proves the key works and returns each domain's status. */
export async function checkProviderKey(key: string): Promise<ProviderKeyCheck> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), TIMEOUT_MS)));
  try {
    const res = await Promise.race([resend.listDomains(key), timeout]);
    if (res === "timeout") return { ok: false, reason: "timeout", message: "Timed out" };
    return { ok: true, domains: res.data.map((d) => ({ name: d.name, status: d.status })) };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unavailable";
    if (err instanceof ResendError && err.code === "restricted_api_key") return { ok: false, reason: "restricted", message };
    if (err instanceof ResendError && (err.status === 401 || err.status === 403)) return { ok: false, reason: "invalid", message };
    return { ok: false, reason: "error", message };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function probe<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Every fact the checks need, gathered in parallel. */
async function snapshot(c: Context<AppEnv>): Promise<HealthSnapshot> {
  const env = c.env;
  const db = env.DB;
  const t = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const { brand, policy, workspace } = await loadSettings(db);
  const [key, webhookSecret] = await Promise.all([providerApiKey(env), getWebhookSecret(env)]);

  const [keyCheck, usage, row, admins, catchAll, cronAt, r2, d1, latestMigration] = await Promise.all([
    key ? checkProviderKey(key) : Promise.resolve(null),
    quotaUsage(env),
    db
      .prepare(
        `SELECT
           (SELECT MAX(created_at) FROM webhook_receipts) AS last_webhook,
           (SELECT MAX(created_at) FROM email_events WHERE type IN ('received','received.unrouted')) AS last_inbound,
           (SELECT COUNT(*) FROM messages WHERE status IN ('scheduled','queued') AND scheduled_at < ?1) AS stuck,
           (SELECT COUNT(*) FROM email_events WHERE type = 'accepted' AND created_at >= ?2) AS sent7d,
           (SELECT COUNT(*) FROM email_events WHERE type = 'bounced' AND created_at >= ?2) AS bounced7d,
           (SELECT COUNT(*) FROM email_events WHERE type = 'complained' AND created_at >= ?2) AS complained7d,
           (SELECT COUNT(*) FROM suppressions) AS suppressed,
           (SELECT COUNT(*) FROM users WHERE role = 'owner' AND status = 'active') AS owners,
           (SELECT COUNT(*) FROM users WHERE status = 'active') AS active_users,
           (SELECT COUNT(*) FROM users u WHERE u.status = 'active'
              AND (u.totp_enabled = 1 OR EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id = u.id))) AS with2fa,
           (SELECT COUNT(*) FROM users WHERE status = 'invited') AS pending_invites,
           (SELECT COUNT(*) FROM users u WHERE u.status = 'invited' AND NOT EXISTS (
              SELECT 1 FROM tokens k WHERE k.user_id = u.id AND k.type = 'invite' AND k.used_at IS NULL AND k.expires_at > ?3)) AS expired_invites,
           (SELECT COUNT(*) FROM messages WHERE mailbox_id = 'system-unrouted' AND date >= ?4) AS unrouted`,
      )
      .bind(iso(t - 10 * 60_000), iso(t - 7 * 86_400_000), iso(t), iso(t - 30 * 86_400_000))
      .first<Record<string, number | string | null>>(),
    db
      .prepare(
        `SELECT email FROM users u WHERE u.status = 'active' AND u.role IN ('owner','admin') AND u.password_hash IS NOT NULL
           AND u.totp_enabled = 0 AND NOT EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id = u.id) ORDER BY email LIMIT 20`,
      )
      .all<{ email: string }>(),
    policy.catchAllMailboxId
      ? db.prepare("SELECT address FROM mailboxes WHERE id = ? AND is_active = 1").bind(policy.catchAllMailboxId).first<{ address: string }>()
      : Promise.resolve(null),
    lastCronRun(db).catch(() => null),
    probe(() => env.FILES.list({ limit: 1 })),
    // A recent migration (0019) added the secrets table.
    probe(() => db.prepare("SELECT name FROM secrets LIMIT 1").all()),
    db
      .prepare("SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1")
      .first<{ name: string }>()
      .then((r) => r?.name ?? null)
      .catch(() => null),
  ]);

  const webhooks = workspace.features.webhooks ? await webhookHealth(db) : undefined;
  const n = (k: string) => Number(row?.[k] ?? 0);
  const s = (k: string) => (row?.[k] as string | null) ?? null;
  const allow = policy.ipAllowlist ?? [];
  return {
    now: t,
    provider: { keyPresent: !!key, keyCheck, webhookSecret: !!webhookSecret },
    inbound: { lastWebhookAt: s("last_webhook"), lastInboundAt: s("last_inbound") },
    domains: { primary: brand.primaryDomain, all: mailDomains(brand) },
    cron: { lastRunAt: cronAt, stuckScheduled: n("stuck") },
    sending: {
      today: usage.today,
      month: usage.month,
      dailyLimit: usage.dailyLimit,
      monthlyLimit: usage.monthlyLimit,
      sent7d: n("sent7d"),
      bounced7d: n("bounced7d"),
      complained7d: n("complained7d"),
      suppressed: n("suppressed"),
    },
    security: {
      owners: n("owners"),
      activeUsers: n("active_users"),
      with2fa: n("with2fa"),
      require2fa: policy.require2fa,
      adminsWithout2fa: admins.results.map((a) => a.email),
      pendingInvites: n("pending_invites"),
      expiredInvites: n("expired_invites"),
      ipAllowlist: allow,
      ipEnforceFor: policy.ipAllowlistEnforceFor,
      requesterAllowed: allow.length ? ipAllowed(allowlistIp(c), allow) : null,
      sessionSecretLength: env.SESSION_SECRET?.length ?? 0,
      appUrl: env.APP_URL ?? "",
      requestOrigin: new URL(c.req.url).origin,
      googleEnabled: policy.googleSsoEnabled,
      googleClientId: !!env.GOOGLE_CLIENT_ID,
      googleClientSecret: !!env.GOOGLE_CLIENT_SECRET,
      pushFeature: workspace.features.push,
      vapidKey: !!env.VAPID_PRIVATE_JWK,
    },
    storage: {
      r2: r2.ok ? { ok: true } : { ok: false, message: r2.message },
      d1: d1.ok ? { ok: true, latest: latestMigration } : { ok: false, latest: latestMigration, message: d1.message },
    },
    routing: {
      unrouted: n("unrouted"),
      allTraffic: workspace.features.allTraffic,
      catchAll: catchAll?.address ?? null,
      catchAllMissing: !!policy.catchAllMailboxId && !catchAll,
    },
    webhooks,
  };
}

// One report per origin, reused for a minute (the provider call is the slow part).
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; report: Promise<HealthReport> }>();

adminHealthRoutes.get("/", async (c) => {
  const origin = new URL(c.req.url).origin;
  const hit = cache.get(origin);
  const fresh = c.req.query("refresh") !== "1" && hit && Date.now() - hit.at < TTL_MS;
  if (!fresh) {
    const report = snapshot(c).then((s) => summarize(evaluateHealth(s), new Date(s.now).toISOString()));
    cache.set(origin, { at: Date.now(), report });
    // A failed run shouldn't be served from the cache.
    report.catch(() => cache.delete(origin));
  }
  return c.json(await cache.get(origin)!.report);
});
