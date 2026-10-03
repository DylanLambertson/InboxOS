/**
 * Health checks as pure functions: the route gathers a snapshot of facts
 * (database counts, env, provider responses) and these turn it into findings.
 * Kept free of I/O so every rule is unit-tested.
 */
import type { HealthCheck, HealthReport, HealthStatus } from "@shared/health";

const DAY = 86_400_000;

export interface ProviderDomain {
  name: string;
  status: string;
}

export type ProviderKeyCheck =
  | { ok: true; domains: ProviderDomain[] }
  | { ok: false; reason: "restricted" | "invalid" | "timeout" | "error"; message: string };

export interface HealthSnapshot {
  /** Epoch ms the snapshot was taken. */
  now: number;
  provider: { keyPresent: boolean; keyCheck: ProviderKeyCheck | null; webhookSecret: boolean };
  inbound: { lastWebhookAt: string | null; lastInboundAt: string | null };
  domains: { primary: string; all: string[] };
  cron: { lastRunAt: string | null; stuckScheduled: number };
  sending: {
    today: number;
    month: number;
    dailyLimit: number;
    monthlyLimit: number;
    sent7d: number;
    bounced7d: number;
    complained7d: number;
    suppressed: number;
  };
  security: {
    owners: number;
    activeUsers: number;
    with2fa: number;
    require2fa: boolean;
    /** Owners/admins who can sign in with a password but have no second factor. */
    adminsWithout2fa: string[];
    pendingInvites: number;
    expiredInvites: number;
    ipAllowlist: string[];
    ipEnforceFor: "everyone" | "admins";
    /** Whether the person running the checks is inside the allowlist (null when it's empty). */
    requesterAllowed: boolean | null;
    sessionSecretLength: number;
    appUrl: string;
    requestOrigin: string;
    googleEnabled: boolean;
    googleClientId: boolean;
    googleClientSecret: boolean;
    pushFeature: boolean;
    vapidKey: boolean;
  };
  storage: { r2: { ok: boolean; message?: string }; d1: { ok: boolean; latest: string | null; message?: string } };
  routing: { unrouted: number; allTraffic: boolean; catchAll: string | null; catchAllMissing: boolean };
}

/** "5 minutes ago", "3 days ago": coarse ages for check details. */
export function ago(iso: string | null, now: number): string {
  if (!iso) return "never";
  const ms = Math.max(0, now - Date.parse(iso));
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const pct = (n: number) => `${(n * 100).toFixed(n < 0.01 ? 2 : 1)}%`;

// ---- Email provider ---------------------------------------------------------

export function providerChecks(s: HealthSnapshot): HealthCheck[] {
  const out: HealthCheck[] = [];
  const { keyPresent, keyCheck, webhookSecret } = s.provider;
  if (!keyPresent) {
    out.push({
      id: "provider.key",
      area: "provider",
      status: "fail",
      title: "No email provider API key",
      detail: "Mail can't be sent and received mail can't be fetched until an API key is connected.",
      fix: { label: "Connect provider", to: "/admin/setup" },
    });
  } else if (keyCheck && !keyCheck.ok) {
    const restricted = keyCheck.reason === "restricted";
    out.push({
      id: "provider.key",
      area: "provider",
      status: restricted ? "info" : keyCheck.reason === "timeout" ? "warn" : "fail",
      title: restricted ? "API key can send only" : keyCheck.reason === "timeout" ? "Provider didn't answer in time" : "API key was rejected",
      detail: restricted
        ? "The key works for sending, but domain status can't be checked from here. A full-access key enables these checks."
        : keyCheck.reason === "timeout"
          ? "The provider took longer than 5 seconds to respond. Try again in a minute."
          : `The provider said: ${keyCheck.message}`,
      fix: restricted ? undefined : { label: "Update key", to: "/admin/setup" },
    });
  } else {
    out.push({ id: "provider.key", area: "provider", status: "ok", title: "API key connected", detail: "The provider accepted the key." });
  }
  out.push(
    webhookSecret
      ? { id: "provider.webhook", area: "provider", status: "ok", title: "Webhook signing secret set", detail: "Incoming mail and delivery updates are verified." }
      : {
          id: "provider.webhook",
          area: "provider",
          status: "fail",
          title: "No webhook signing secret",
          detail: "Incoming mail and delivery updates are rejected until the signing secret is set.",
          fix: { label: "Finish setup", to: "/admin/setup" },
        },
  );

  const { lastWebhookAt, lastInboundAt } = s.inbound;
  const latest = [lastWebhookAt, lastInboundAt].filter(Boolean).sort().pop() ?? null;
  const hasDomains = s.domains.all.length > 0;
  const stale = latest ? s.now - Date.parse(latest) > 7 * DAY : true;
  out.push({
    id: "provider.inbound",
    area: "provider",
    status: !hasDomains ? "info" : stale ? "warn" : "ok",
    title: !latest ? "No mail received yet" : stale ? "No mail received in 7 days" : "Receiving mail",
    detail: latest
      ? `Last webhook ${ago(lastWebhookAt, s.now)}; last message received ${ago(lastInboundAt, s.now)}.`
      : hasDomains
        ? "Nothing has arrived from the provider yet. Check that receiving is enabled for your domain and the webhook points here."
        : "Add a mail domain to start receiving.",
    fix: hasDomains && stale ? { label: "Check domains", to: "/admin/domains" } : undefined,
  });
  return out;
}

// ---- Domains ------------------------------------------------------------------

const DOMAIN_STATUS: Record<string, HealthStatus> = { verified: "ok", failed: "fail", temporary_failure: "fail" };

export function domainChecks(s: HealthSnapshot): HealthCheck[] {
  const out: HealthCheck[] = [];
  if (!s.domains.primary) {
    out.push({
      id: "domains.primary",
      area: "domains",
      status: "fail",
      title: "No primary domain",
      detail: "New mailboxes need a domain to live on.",
      fix: { label: "Add domain", to: "/admin/domains" },
    });
    return out;
  }
  out.push({ id: "domains.primary", area: "domains", status: "ok", title: "Primary domain set", detail: s.domains.primary });
  const check = s.provider.keyCheck;
  if (!check?.ok) return out;
  const byName = new Map(check.domains.map((d) => [d.name.toLowerCase(), d]));
  for (const name of s.domains.all) {
    const d = byName.get(name);
    if (!d) {
      out.push({
        id: `domains.${name}`,
        area: "domains",
        status: "warn",
        title: `${name} isn't added to the provider`,
        detail: "Mail from this domain can't be sent until it's added and verified with your email provider.",
        fix: { label: "Set up domain", to: "/admin/domains" },
      });
      continue;
    }
    const status = DOMAIN_STATUS[d.status] ?? "warn";
    out.push({
      id: `domains.${name}`,
      area: "domains",
      status,
      title: status === "ok" ? `${name} is verified` : `${name} is ${d.status.replace(/_/g, " ")}`,
      detail: status === "ok" ? "DNS records are in place." : "Some DNS records are missing or haven't been checked yet.",
      fix: status === "ok" ? undefined : { label: "Fix DNS", to: "/admin/domains" },
    });
  }
  return out;
}

// ---- Background jobs ----------------------------------------------------------

export function jobChecks(s: HealthSnapshot): HealthCheck[] {
  const { lastRunAt, stuckScheduled } = s.cron;
  const age = lastRunAt ? s.now - Date.parse(lastRunAt) : Infinity;
  const docs = { label: "About cron triggers", href: "https://developers.cloudflare.com/workers/configuration/cron-triggers/" };
  const out: HealthCheck[] = [
    {
      id: "jobs.cron",
      area: "jobs",
      status: !lastRunAt ? "warn" : age > 60 * 60_000 ? "fail" : age > 5 * 60_000 ? "warn" : "ok",
      title: !lastRunAt ? "Scheduled jobs haven't run yet" : age > 5 * 60_000 ? "Scheduled jobs are behind" : "Scheduled jobs are running",
      detail: !lastRunAt
        ? "No run has been recorded. Scheduled send, snooze and cleanup need the every-minute cron trigger."
        : `Last run ${ago(lastRunAt, s.now)}.${age > 5 * 60_000 ? " Scheduled send, snooze and cleanup are paused until it runs again." : ""}`,
      fix: !lastRunAt || age > 5 * 60_000 ? docs : undefined,
    },
  ];
  if (stuckScheduled > 0) {
    out.push({
      id: "jobs.stuck",
      area: "jobs",
      status: "warn",
      title: `${plural(stuckScheduled, "scheduled message")} past due`,
      detail: "These should have gone out more than 10 minutes ago.",
      fix: { label: "Open delivery log", to: "/admin/logs/delivery" },
    });
  }
  return out;
}

// ---- Sending --------------------------------------------------------------------

function quotaCheck(id: string, label: string, used: number, limit: number): HealthCheck {
  if (limit <= 0) return { id, area: "sending", status: "info", title: `${label}: no limit`, detail: `${used.toLocaleString("en-US")} sent so far.` };
  const share = used / limit;
  return {
    id,
    area: "sending",
    status: share >= 1 ? "fail" : share >= 0.8 ? "warn" : "ok",
    title: share >= 1 ? `${label} reached` : `${label}: ${Math.round(share * 100)}% used`,
    detail: `${used.toLocaleString("en-US")} of ${limit.toLocaleString("en-US")}.${share >= 1 ? " New mail is held until the limit resets." : ""}`,
    fix: share >= 0.8 ? { label: "Adjust limits", to: "/admin/settings" } : undefined,
  };
}

export function sendingChecks(s: HealthSnapshot): HealthCheck[] {
  const q = s.sending;
  const out = [quotaCheck("sending.daily", "Daily quota", q.today, q.dailyLimit), quotaCheck("sending.monthly", "Monthly quota", q.month, q.monthlyLimit)];
  const enough = q.sent7d >= 20;
  const bounce = q.sent7d ? q.bounced7d / q.sent7d : 0;
  const complaint = q.sent7d ? q.complained7d / q.sent7d : 0;
  out.push({
    id: "sending.bounces",
    area: "sending",
    status: !enough ? "info" : bounce >= 0.04 ? "fail" : bounce >= 0.02 ? "warn" : "ok",
    title: enough ? `Bounce rate ${pct(bounce)}` : "Bounce rate",
    detail: enough
      ? `${plural(q.bounced7d, "bounce")} from ${plural(q.sent7d, "message")} in the last 7 days. Keep it under 2%.`
      : "Not enough mail in the last 7 days to measure.",
    fix: enough && bounce >= 0.02 ? { label: "See bounces", to: "/admin/logs/delivery" } : undefined,
  });
  out.push({
    id: "sending.complaints",
    area: "sending",
    status: !enough ? "info" : complaint >= 0.003 ? "fail" : complaint >= 0.001 ? "warn" : "ok",
    title: enough ? `Spam complaint rate ${pct(complaint)}` : "Spam complaint rate",
    detail: enough
      ? `${plural(q.complained7d, "complaint")} in the last 7 days. Mailbox providers start filtering above 0.3%.`
      : "Not enough mail in the last 7 days to measure.",
    fix: enough && complaint >= 0.001 ? { label: "See complaints", to: "/admin/logs/delivery" } : undefined,
  });
  out.push({
    id: "sending.suppressed",
    area: "sending",
    status: "info",
    title: `${plural(q.suppressed, "suppressed recipient")}`,
    detail: "Addresses that unsubscribed, bounced or complained aren't sent outreach.",
    fix: q.suppressed ? { label: "View list", to: "/admin/unsubscribes" } : undefined,
  });
  return out;
}

// ---- Security --------------------------------------------------------------------

export function securityChecks(s: HealthSnapshot): HealthCheck[] {
  const x = s.security;
  const out: HealthCheck[] = [];
  out.push({
    id: "security.owners",
    area: "security",
    status: x.owners >= 2 ? "ok" : x.owners === 1 ? "warn" : "fail",
    title: x.owners >= 2 ? `${x.owners} owners` : x.owners === 1 ? "Only one owner" : "No active owner",
    detail: x.owners >= 2 ? "Someone else can step in if an owner is locked out." : "Add a second owner so the workspace isn't stuck if one person loses access.",
    fix: x.owners >= 2 ? undefined : { label: "Manage users", to: "/admin/users" },
  });

  const missing = Math.max(0, x.activeUsers - x.with2fa);
  out.push({
    id: "security.2fa",
    area: "security",
    status: missing === 0 ? "ok" : x.require2fa ? "info" : "warn",
    title: `Two-factor: ${x.with2fa} of ${x.activeUsers} people`,
    detail:
      missing === 0
        ? "Everyone has a passkey or authenticator app."
        : x.require2fa
          ? `Required by policy: ${plural(missing, "person", "people")} will be asked to set it up at their next sign-in.`
          : `${plural(missing, "person", "people")} ${missing === 1 ? "signs" : "sign"} in with just a password. Consider requiring two-factor.`,
    fix: missing && !x.require2fa ? { label: "Require 2FA", to: "/admin/settings" } : undefined,
  });

  if (x.adminsWithout2fa.length) {
    const names = x.adminsWithout2fa.slice(0, 3).join(", ") + (x.adminsWithout2fa.length > 3 ? ` and ${x.adminsWithout2fa.length - 3} more` : "");
    out.push({
      id: "security.admin2fa",
      area: "security",
      status: "warn",
      title: `${plural(x.adminsWithout2fa.length, "admin")} without two-factor`,
      detail: `${names} can change workspace settings with only a password.`,
      fix: { label: "Review admins", to: "/admin/users" },
    });
  }

  if (x.pendingInvites || x.expiredInvites) {
    out.push({
      id: "security.invites",
      area: "security",
      status: x.expiredInvites ? "warn" : "info",
      title: x.expiredInvites ? `${plural(x.expiredInvites, "invite")} expired` : `${plural(x.pendingInvites, "invite")} pending`,
      detail: x.expiredInvites ? "Resend or remove expired invites so they don't linger." : "Waiting for people to accept.",
      fix: { label: "Open users", to: "/admin/users" },
    });
  }

  if (x.ipAllowlist.length) {
    const openAll = x.ipAllowlist.some((c) => /^(0\.0\.0\.0\/0|::\/0)$/.test(c.trim()));
    const status: HealthStatus = openAll ? "warn" : x.requesterAllowed === false ? "warn" : "ok";
    out.push({
      id: "security.ipAllowlist",
      area: "security",
      status,
      title: openAll ? "IP allowlist allows everyone" : x.requesterAllowed === false ? "You're outside the IP allowlist" : "IP allowlist active",
      detail: openAll
        ? "A 0.0.0.0/0 or ::/0 entry lets every address in, so the list has no effect."
        : `${plural(x.ipAllowlist.length, "range")}, enforced for ${x.ipEnforceFor === "admins" ? "admins only" : "everyone"}.${x.requesterAllowed === false ? " Your current network isn't on it." : ""}`,
      fix: status === "ok" ? undefined : { label: "Edit allowlist", to: "/admin/security/access" },
    });
  }

  out.push(
    x.sessionSecretLength >= 32
      ? { id: "security.sessionSecret", area: "security", status: "ok", title: "Session secret is strong", detail: `${x.sessionSecretLength} characters.` }
      : {
          id: "security.sessionSecret",
          area: "security",
          status: "fail",
          title: x.sessionSecretLength ? "Session secret is too short" : "No session secret",
          detail: "Use at least 32 random characters: wrangler secret put SESSION_SECRET.",
        },
  );

  let appOrigin = "";
  try {
    appOrigin = new URL(x.appUrl).origin;
  } catch {
    /* invalid */
  }
  out.push(
    appOrigin && appOrigin === x.requestOrigin
      ? { id: "security.appUrl", area: "security", status: "ok", title: "App URL matches", detail: appOrigin }
      : {
          id: "security.appUrl",
          area: "security",
          status: "warn",
          title: appOrigin ? "App URL doesn't match this address" : "App URL isn't a valid URL",
          detail: `APP_URL is ${x.appUrl || "empty"} but you're using ${x.requestOrigin}. Links in emails, passkeys and Google sign-in use APP_URL.`,
        },
  );

  const googleSecrets = x.googleClientId && x.googleClientSecret;
  if (x.googleEnabled && !googleSecrets) {
    out.push({
      id: "security.google",
      area: "security",
      status: "warn",
      title: "Google sign-in is on but not configured",
      detail: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or turn Google sign-in off. The button is hidden until both are set.",
      fix: { label: "Sign-in policy", to: "/admin/settings" },
    });
  } else if (!x.googleEnabled && (x.googleClientId || x.googleClientSecret)) {
    out.push({
      id: "security.google",
      area: "security",
      status: "info",
      title: "Google sign-in is configured but off",
      detail: googleSecrets ? "Turn it on in Policies to let people sign in with Google." : "Only one of GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET is set.",
      fix: { label: "Sign-in policy", to: "/admin/settings" },
    });
  }

  if (x.pushFeature && !x.vapidKey) {
    out.push({
      id: "security.push",
      area: "security",
      status: "warn",
      title: "Push notifications have no key",
      detail: "Push is switched on, but VAPID_PRIVATE_JWK isn't set, so no notifications are sent.",
      fix: { label: "Features", to: "/admin/features" },
    });
  }
  return out;
}

// ---- Storage ------------------------------------------------------------------------

export function storageChecks(s: HealthSnapshot): HealthCheck[] {
  const { r2, d1 } = s.storage;
  return [
    r2.ok
      ? { id: "storage.r2", area: "storage", status: "ok", title: "File storage reachable", detail: "Attachments and message bodies can be read and written." }
      : { id: "storage.r2", area: "storage", status: "fail", title: "File storage unreachable", detail: r2.message ?? "The R2 bucket didn't respond. Check the FILES binding." },
    d1.ok
      ? { id: "storage.d1", area: "storage", status: "ok", title: "Database is up to date", detail: d1.latest ? `Latest migration: ${d1.latest}` : "All known tables and columns exist." }
      : {
          id: "storage.d1",
          area: "storage",
          status: "fail",
          title: "Database migrations are missing",
          detail: `${d1.message ?? "A recent table or column is missing."} Run: npm run db:migrate:remote`,
        },
  ];
}

// ---- Mail routing ----------------------------------------------------------------------

export function routingChecks(s: HealthSnapshot): HealthCheck[] {
  const r = s.routing;
  const out: HealthCheck[] = [];
  out.push({
    id: "routing.unrouted",
    area: "routing",
    status: r.unrouted ? "warn" : "ok",
    title: r.unrouted ? `${plural(r.unrouted, "message")} with no mailbox` : "Every message found a mailbox",
    detail: r.unrouted
      ? "Mail arrived for addresses nobody owns. Create the mailbox or an alias, or set a catch-all."
      : "No unrouted mail in the last 30 days.",
    fix: r.unrouted && r.allTraffic ? { label: "Review", to: "/admin/traffic" } : undefined,
  });
  out.push({
    id: "routing.catchAll",
    area: "routing",
    status: r.catchAllMissing ? "warn" : "info",
    title: r.catchAllMissing ? "Catch-all mailbox no longer exists" : r.catchAll ? "Catch-all is on" : "No catch-all",
    detail: r.catchAllMissing
      ? "Mail to unknown addresses isn't being caught. Pick another mailbox."
      : r.catchAll
        ? `Mail to unknown addresses goes to ${r.catchAll}.`
        : "Mail to unknown addresses is kept aside instead of delivered.",
    fix: { label: "Change", to: "/admin/settings" },
  });
  return out;
}

// ---- Report ---------------------------------------------------------------------------------

export function evaluateHealth(s: HealthSnapshot): HealthCheck[] {
  return [...providerChecks(s), ...domainChecks(s), ...jobChecks(s), ...sendingChecks(s), ...securityChecks(s), ...storageChecks(s), ...routingChecks(s)];
}

const WEIGHT: Record<HealthStatus, number | null> = { ok: 1, warn: 0.5, fail: 0, info: null };

/** Score out of 100 (info doesn't count), plus how many checks landed in each status. */
export function summarize(checks: HealthCheck[], generatedAt: string): HealthReport {
  const counts: Record<HealthStatus, number> = { ok: 0, warn: 0, fail: 0, info: 0 };
  let sum = 0;
  let n = 0;
  for (const c of checks) {
    counts[c.status]++;
    const w = WEIGHT[c.status];
    if (w !== null) (sum += w, n++);
  }
  return { checks, counts, score: n ? Math.round((sum / n) * 100) : 100, generatedAt };
}
