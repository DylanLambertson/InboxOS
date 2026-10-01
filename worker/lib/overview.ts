/** Admin dashboard data: quotas, counts, KPIs with deltas, the 14-day chart and recent problems. */
import type { OverviewData } from "@shared/admin";
import type { Env } from "../env";
import { quotaUsage } from "./send";

const KPI_DAYS = 7;
const OVERVIEW_TTL_MS = 20_000;
let overviewCache: { at: number; data: Promise<OverviewData> } | null = null;

/** Everything the dashboard shows, in one parallel round of queries. */
export async function buildOverview(env: Env): Promise<OverviewData> {
  const db = env.DB;
  const since = new Date(Date.now() - 13 * 86_400_000);
  since.setUTCHours(0, 0, 0, 0);
  const t = Date.now();
  const cur = new Date(t - KPI_DAYS * 86_400_000).toISOString();
  const prev = new Date(t - 2 * KPI_DAYS * 86_400_000).toISOString();
  const [usage, counts, { results: series }, { results: recentProblems }, { results: kpiRows }, active] = await Promise.all([
    quotaUsage(env),
    db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM users WHERE status = 'active') AS users,
           (SELECT COUNT(*) FROM users WHERE status = 'invited') AS invited,
           (SELECT COUNT(*) FROM mailboxes WHERE is_active = 1 AND is_system = 0) AS mailboxes,
           (SELECT COUNT(*) FROM messages WHERE mailbox_id = 'system-unrouted') AS unrouted,
           (SELECT COUNT(*) FROM messages) AS messages,
           (SELECT COALESCE(SUM(size), 0) FROM messages) AS bytes,
           (SELECT COUNT(*) FROM messages WHERE status = 'scheduled') AS scheduled`,
      )
      .first<OverviewData["counts"]>(),
    db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day, type, COUNT(*) AS n FROM email_events
         WHERE created_at >= ? GROUP BY day, type ORDER BY day`,
      )
      .bind(since.toISOString())
      .all<{ day: string; type: string; n: number }>(),
    db
      .prepare(
        `SELECT e.id, e.type, e.detail, e.recipient, e.created_at, m.subject, m.id AS message_id
         FROM email_events e LEFT JOIN messages m ON m.id = e.message_id
         WHERE e.type IN ('bounced','complained','failed','delivery_delayed','suppressed','received.unrouted')
         ORDER BY e.created_at DESC LIMIT 8`,
      )
      .all<OverviewData["recentProblems"][number]>(),
    db
      .prepare(
        `SELECT type, SUM(CASE WHEN created_at >= ?1 THEN 1 ELSE 0 END) AS cur, SUM(CASE WHEN created_at < ?1 THEN 1 ELSE 0 END) AS prev
         FROM email_events WHERE created_at >= ?2 AND type IN ('accepted','received','received.unrouted','bounced','complained') GROUP BY type`,
      )
      .bind(cur, prev)
      .all<{ type: string; cur: number; prev: number }>(),
    // Active = signed in or sent mail during the period.
    db
      .prepare(
        `SELECT
           (SELECT COUNT(DISTINCT uid) FROM (
              SELECT user_id AS uid FROM login_events WHERE outcome = 'success' AND user_id IS NOT NULL AND created_at >= ?1
              UNION SELECT created_by FROM messages WHERE direction = 'outbound' AND created_by IS NOT NULL AND sent_at >= ?1)) AS cur,
           (SELECT COUNT(DISTINCT uid) FROM (
              SELECT user_id AS uid FROM login_events WHERE outcome = 'success' AND user_id IS NOT NULL AND created_at >= ?2 AND created_at < ?1
              UNION SELECT created_by FROM messages WHERE direction = 'outbound' AND created_by IS NOT NULL AND sent_at >= ?2 AND sent_at < ?1)) AS prev`,
      )
      .bind(cur, prev)
      .first<{ cur: number; prev: number }>(),
  ]);
  const kpi = (...types: string[]) => {
    const rows = kpiRows.filter((r) => types.includes(r.type));
    return { current: rows.reduce((s, r) => s + (r.cur ?? 0), 0), previous: rows.reduce((s, r) => s + (r.prev ?? 0), 0) };
  };
  return {
    usage,
    counts: counts ?? { users: 0, invited: 0, mailboxes: 0, messages: 0, bytes: 0, scheduled: 0, unrouted: 0 },
    kpiDays: KPI_DAYS,
    kpis: {
      sent: kpi("accepted"),
      received: kpi("received", "received.unrouted"),
      bounces: kpi("bounced"),
      complaints: kpi("complained"),
      activeUsers: { current: active?.cur ?? 0, previous: active?.prev ?? 0 },
    },
    series,
    recentProblems,
    provider: {
      apiKey: !!env.RESEND_API_KEY,
      webhookSecret: !!env.RESEND_WEBHOOK_SECRET,
      google: !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET,
      webhookUrl: `${env.APP_URL.replace(/\/$/, "")}/webhooks/resend`,
    },
    generatedAt: new Date(t).toISOString(),
  };
}

/** The dashboard data, shared by every admin for a few seconds. `refresh` skips the cache. */
export function getOverview(env: Env, refresh = false): Promise<OverviewData> {
  if (!overviewCache || refresh || Date.now() - overviewCache.at > OVERVIEW_TTL_MS) {
    const data = buildOverview(env);
    overviewCache = { at: Date.now(), data };
    data.catch(() => (overviewCache = null));
  }
  return overviewCache.data;
}
