import { describe, expect, it } from "vitest";
import {
  ago,
  domainChecks,
  evaluateHealth,
  jobChecks,
  providerChecks,
  routingChecks,
  securityChecks,
  sendingChecks,
  storageChecks,
  summarize,
  webhookChecks,
  type HealthSnapshot,
} from "../worker/lib/health-checks";
import { healthIssueCount } from "../shared/health";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function healthy(): HealthSnapshot {
  return {
    now: NOW,
    provider: { keyPresent: true, keyCheck: { ok: true, domains: [{ name: "example.com", status: "verified" }] }, webhookSecret: true },
    inbound: { lastWebhookAt: minutesAgo(30), lastInboundAt: minutesAgo(45) },
    domains: { primary: "example.com", all: ["example.com"] },
    cron: { lastRunAt: minutesAgo(1), stuckScheduled: 0 },
    sending: { today: 10, month: 200, dailyLimit: 100, monthlyLimit: 3000, sent7d: 500, bounced7d: 2, complained7d: 0, suppressed: 3 },
    security: {
      owners: 2,
      activeUsers: 5,
      with2fa: 5,
      require2fa: true,
      adminsWithout2fa: [],
      pendingInvites: 0,
      expiredInvites: 0,
      ipAllowlist: [],
      ipEnforceFor: "everyone",
      requesterAllowed: null,
      sessionSecretLength: 64,
      appUrl: "https://mail.example.com",
      requestOrigin: "https://mail.example.com",
      googleEnabled: false,
      googleClientId: false,
      googleClientSecret: false,
      pushFeature: true,
      vapidKey: true,
    },
    storage: { r2: { ok: true }, d1: { ok: true, latest: "0018_outbound_policy.sql" } },
    routing: { unrouted: 0, allTraffic: true, catchAll: null, catchAllMissing: false },
  };
}

const byId = (checks: { id: string }[], id: string) => checks.find((c) => c.id === id) as ReturnType<typeof evaluateHealth>[number];

describe("health: a well-configured install", () => {
  it("has no failures or warnings and scores 100", () => {
    const report = summarize(evaluateHealth(healthy()), "now");
    expect(report.checks.filter((c) => c.status === "fail" || c.status === "warn")).toEqual([]);
    expect(report.score).toBe(100);
    expect(healthIssueCount(report)).toBe(0);
  });

  it("gives every check a unique id and an area", () => {
    const checks = evaluateHealth(healthy());
    expect(new Set(checks.map((c) => c.id)).size).toBe(checks.length);
    for (const c of checks) expect(c.area).toBeTruthy();
  });
});

describe("health: provider", () => {
  it("fails without a key and points to setup", () => {
    const s = healthy();
    s.provider = { keyPresent: false, keyCheck: null, webhookSecret: true };
    const c = byId(providerChecks(s), "provider.key");
    expect(c.status).toBe("fail");
    expect(c.fix?.to).toBe("/admin/setup");
  });

  it("treats a send-only key as informational, a rejected key as a failure and a timeout as a warning", () => {
    const s = healthy();
    s.provider.keyCheck = { ok: false, reason: "restricted", message: "restricted" };
    expect(byId(providerChecks(s), "provider.key").status).toBe("info");
    s.provider.keyCheck = { ok: false, reason: "invalid", message: "API key is invalid" };
    expect(byId(providerChecks(s), "provider.key")).toMatchObject({ status: "fail", detail: expect.stringContaining("API key is invalid") });
    s.provider.keyCheck = { ok: false, reason: "timeout", message: "Timed out" };
    expect(byId(providerChecks(s), "provider.key").status).toBe("warn");
  });

  it("fails without a webhook signing secret", () => {
    const s = healthy();
    s.provider.webhookSecret = false;
    expect(byId(providerChecks(s), "provider.webhook").status).toBe("fail");
  });

  it("warns when domains exist but nothing arrived in 7 days", () => {
    const s = healthy();
    s.inbound = { lastWebhookAt: minutesAgo(8 * 24 * 60), lastInboundAt: null };
    expect(byId(providerChecks(s), "provider.inbound")).toMatchObject({ status: "warn", fix: { to: "/admin/domains" } });
    s.inbound = { lastWebhookAt: null, lastInboundAt: null };
    expect(byId(providerChecks(s), "provider.inbound")).toMatchObject({ status: "warn", title: "No mail received yet" });
  });

  it("only informs about inbound mail when there are no domains", () => {
    const s = healthy();
    s.domains = { primary: "", all: [] };
    s.inbound = { lastWebhookAt: null, lastInboundAt: null };
    expect(byId(providerChecks(s), "provider.inbound").status).toBe("info");
  });
});

describe("health: domains", () => {
  it("fails without a primary domain and stops there", () => {
    const s = healthy();
    s.domains = { primary: "", all: [] };
    const checks = domainChecks(s);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ id: "domains.primary", status: "fail" });
  });

  it("maps provider statuses and flags domains the provider doesn't know", () => {
    const s = healthy();
    s.domains.all = ["example.com", "example.org", "example.net", "example.io"];
    s.provider.keyCheck = {
      ok: true,
      domains: [
        { name: "example.com", status: "verified" },
        { name: "Example.org", status: "pending" },
        { name: "example.net", status: "failed" },
      ],
    };
    const checks = domainChecks(s);
    expect(byId(checks, "domains.example.com").status).toBe("ok");
    expect(byId(checks, "domains.example.org")).toMatchObject({ status: "warn", title: "example.org is pending" });
    expect(byId(checks, "domains.example.net").status).toBe("fail");
    expect(byId(checks, "domains.example.io")).toMatchObject({ status: "warn", fix: { to: "/admin/domains" } });
  });

  it("skips per-domain checks when the provider couldn't be asked", () => {
    const s = healthy();
    s.provider.keyCheck = { ok: false, reason: "restricted", message: "" };
    expect(domainChecks(s).map((c) => c.id)).toEqual(["domains.primary"]);
  });
});

describe("health: background jobs", () => {
  it("is ok within 5 minutes, warns after, fails after an hour", () => {
    const s = healthy();
    expect(byId(jobChecks(s), "jobs.cron").status).toBe("ok");
    s.cron.lastRunAt = minutesAgo(6);
    expect(byId(jobChecks(s), "jobs.cron").status).toBe("warn");
    s.cron.lastRunAt = minutesAgo(61);
    expect(byId(jobChecks(s), "jobs.cron").status).toBe("fail");
    s.cron.lastRunAt = null;
    expect(byId(jobChecks(s), "jobs.cron")).toMatchObject({ status: "warn", fix: { href: expect.stringContaining("cron") } });
  });

  it("reports scheduled mail stuck past due", () => {
    const s = healthy();
    s.cron.stuckScheduled = 3;
    expect(byId(jobChecks(s), "jobs.stuck")).toMatchObject({ status: "warn", title: "3 scheduled messages past due" });
  });
});

describe("health: sending", () => {
  it("rates quota use", () => {
    const s = healthy();
    s.sending.today = 85;
    expect(byId(sendingChecks(s), "sending.daily").status).toBe("warn");
    s.sending.today = 100;
    expect(byId(sendingChecks(s), "sending.daily").status).toBe("fail");
    s.sending.dailyLimit = 0;
    expect(byId(sendingChecks(s), "sending.daily").status).toBe("info");
  });

  it("rates bounce and complaint rates only with enough volume", () => {
    const s = healthy();
    s.sending.sent7d = 100;
    s.sending.bounced7d = 3;
    expect(byId(sendingChecks(s), "sending.bounces").status).toBe("warn");
    s.sending.bounced7d = 5;
    expect(byId(sendingChecks(s), "sending.bounces")).toMatchObject({ status: "fail", title: "Bounce rate 5.0%" });
    s.sending.complained7d = 1;
    expect(byId(sendingChecks(s), "sending.complaints").status).toBe("fail");
    s.sending.sent7d = 10;
    expect(byId(sendingChecks(s), "sending.bounces").status).toBe("info");
    expect(byId(sendingChecks(s), "sending.complaints").status).toBe("info");
  });
});

describe("health: security", () => {
  it("recommends a second owner", () => {
    const s = healthy();
    s.security.owners = 1;
    expect(byId(securityChecks(s), "security.owners").status).toBe("warn");
    s.security.owners = 0;
    expect(byId(securityChecks(s), "security.owners").status).toBe("fail");
  });

  it("weighs two-factor coverage against the policy", () => {
    const s = healthy();
    s.security.with2fa = 3;
    expect(byId(securityChecks(s), "security.2fa").status).toBe("info");
    s.security.require2fa = false;
    expect(byId(securityChecks(s), "security.2fa")).toMatchObject({ status: "warn", fix: { to: "/admin/settings" } });
  });

  it("names admins who sign in with only a password", () => {
    const s = healthy();
    s.security.adminsWithout2fa = ["a@x.com", "b@x.com", "c@x.com", "d@x.com"];
    expect(byId(securityChecks(s), "security.admin2fa")).toMatchObject({ status: "warn", detail: expect.stringContaining("and 1 more") });
  });

  it("flags expired invites, odd allowlists, weak secrets and mismatched URLs", () => {
    const s = healthy();
    s.security.expiredInvites = 2;
    s.security.ipAllowlist = ["0.0.0.0/0"];
    s.security.sessionSecretLength = 12;
    s.security.appUrl = "https://old.example.com/";
    const checks = securityChecks(s);
    expect(byId(checks, "security.invites").status).toBe("warn");
    expect(byId(checks, "security.ipAllowlist")).toMatchObject({ status: "warn", title: "IP allowlist allows everyone" });
    expect(byId(checks, "security.sessionSecret").status).toBe("fail");
    expect(byId(checks, "security.appUrl").status).toBe("warn");
  });

  it("warns when the requester is outside the allowlist", () => {
    const s = healthy();
    s.security.ipAllowlist = ["203.0.113.0/24"];
    s.security.requesterAllowed = false;
    expect(byId(securityChecks(s), "security.ipAllowlist").status).toBe("warn");
    s.security.requesterAllowed = true;
    expect(byId(securityChecks(s), "security.ipAllowlist").status).toBe("ok");
  });

  it("catches half-configured Google sign-in and push", () => {
    const s = healthy();
    s.security.googleEnabled = true;
    s.security.googleClientId = true;
    expect(byId(securityChecks(s), "security.google").status).toBe("warn");
    s.security.googleEnabled = false;
    expect(byId(securityChecks(s), "security.google").status).toBe("info");
    s.security.vapidKey = false;
    expect(byId(securityChecks(s), "security.push").status).toBe("warn");
    s.security.pushFeature = false;
    expect(byId(securityChecks(s), "security.push")).toBeUndefined();
  });
});

describe("health: storage and routing", () => {
  it("fails when storage or migrations are missing", () => {
    const s = healthy();
    s.storage = { r2: { ok: false, message: "no bucket" }, d1: { ok: false, latest: null, message: "no such column: job_title" } };
    const checks = storageChecks(s);
    expect(byId(checks, "storage.r2")).toMatchObject({ status: "fail", detail: "no bucket" });
    expect(byId(checks, "storage.d1").detail).toContain("db:migrate");
  });

  it("warns about unrouted mail and links to All traffic only when it's on", () => {
    const s = healthy();
    s.routing.unrouted = 4;
    expect(byId(routingChecks(s), "routing.unrouted")).toMatchObject({ status: "warn", fix: { to: "/admin/traffic" } });
    s.routing.allTraffic = false;
    expect(byId(routingChecks(s), "routing.unrouted").fix).toBeUndefined();
    s.routing.catchAllMissing = true;
    expect(byId(routingChecks(s), "routing.catchAll").status).toBe("warn");
  });
});

describe("health: summary", () => {
  it("scores ok as 1, warn as half, fail as 0 and ignores info", () => {
    const r = summarize(
      [
        { id: "a", area: "jobs", status: "ok", title: "", detail: "" },
        { id: "b", area: "jobs", status: "warn", title: "", detail: "" },
        { id: "c", area: "jobs", status: "fail", title: "", detail: "" },
        { id: "d", area: "jobs", status: "info", title: "", detail: "" },
      ],
      "t",
    );
    expect(r.score).toBe(50);
    expect(r.counts).toEqual({ ok: 1, warn: 1, fail: 1, info: 1 });
    expect(healthIssueCount(r)).toBe(2);
  });

  it("formats ages", () => {
    expect(ago(null, NOW)).toBe("never");
    expect(ago(minutesAgo(0), NOW)).toBe("just now");
    expect(ago(minutesAgo(1), NOW)).toBe("1 minute ago");
    expect(ago(minutesAgo(120), NOW)).toBe("2 hours ago");
    expect(ago(minutesAgo(3 * 24 * 60), NOW)).toBe("3 days ago");
  });
});

describe("health: outbound webhooks", () => {
  it("says nothing when webhooks aren't used", () => {
    expect(webhookChecks(healthy())).toEqual([]);
    expect(webhookChecks({ ...healthy(), webhooks: { endpoints: 0, failing: [], autoDisabled: [] } })).toEqual([]);
  });
  it("is ok while endpoints deliver, and warns about failing or switched-off ones", () => {
    expect(webhookChecks({ ...healthy(), webhooks: { endpoints: 2, failing: [], autoDisabled: [] } })[0].status).toBe("ok");
    const failing = webhookChecks({ ...healthy(), webhooks: { endpoints: 2, failing: [{ url: "https://a.example/h", streak: 5 }], autoDisabled: [] } })[0];
    expect(failing).toMatchObject({ status: "warn", title: "1 webhook endpoint failing" });
    expect(failing.detail).toContain("5 times");
    const off = webhookChecks({ ...healthy(), webhooks: { endpoints: 1, failing: [], autoDisabled: ["https://b.example/h"] } })[0];
    expect(off.title).toBe("1 webhook endpoint turned off after failing");
    expect(off.fix?.to).toBe("/admin/webhooks");
  });
});
