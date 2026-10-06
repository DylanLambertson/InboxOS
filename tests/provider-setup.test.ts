import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../worker/env";
import { credentialStatus, getResendApiKey, getWebhookSecret, invalidateProviderConfig, storeCredential, clearCredential } from "../worker/lib/provider-config";
import { createFirstOwner, sanitizeSetupState, setupKeyMatches, setupKeySource, webhookUrlProblem } from "../worker/lib/setup";
import { deriveSteps, nextStep, setupProgress, type SetupFacts } from "../shared/setup";

/** Just enough of D1 for the secrets table and the first-owner insert. */
function fakeDb() {
  const secrets = new Map<string, { value: string; updated_at: string; updated_by: string | null }>();
  const users: string[] = [];
  const db = {
    secrets,
    users,
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind: (...a: unknown[]) => ((args = a), stmt),
        async first() {
          if (sql.startsWith("SELECT value, updated_at, updated_by FROM secrets")) return secrets.get(args[0] as string) ?? null;
          throw new Error(`unexpected first(): ${sql}`);
        },
        async run() {
          if (sql.includes("INSERT INTO secrets")) {
            secrets.set(args[0] as string, { value: args[1] as string, updated_at: args[2] as string, updated_by: args[3] as string | null });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("DELETE FROM secrets")) return { meta: { changes: secrets.delete(args[0] as string) ? 1 : 0 } };
          if (sql.includes("INSERT INTO users") && sql.includes("WHERE NOT EXISTS (SELECT 1 FROM users)")) {
            if (users.length) return { meta: { changes: 0 } };
            users.push(args[0] as string);
            return { meta: { changes: 1 } };
          }
          throw new Error(`unexpected run(): ${sql}`);
        },
      };
      return stmt;
    },
  };
  return db;
}

const env = (over: Partial<Env> = {}) => ({ DB: fakeDb() as unknown as D1Database, SESSION_SECRET: "test-session-secret-0123456789abcdef", APP_URL: "https://mail.example.com", ...over }) as Env;

afterEach(() => invalidateProviderConfig());

describe("provider credentials", () => {
  it("prefers the environment variable over a stored value", async () => {
    const e = env({ RESEND_API_KEY: "re_from_env_123456" });
    await storeCredential(e, "apiKey", "re_stored_abcdefgh", "u1");
    expect(await getResendApiKey(e)).toBe("re_from_env_123456");
    const s = await credentialStatus(e, "apiKey");
    expect(s).toMatchObject({ configured: true, source: "env" });
  });

  it("falls back to the stored, encrypted value", async () => {
    const e = env();
    expect(await getResendApiKey(e)).toBeUndefined();
    await storeCredential(e, "apiKey", "re_stored_abcdefgh", "u1");
    const raw = (e.DB as unknown as ReturnType<typeof fakeDb>).secrets.get("resend.api_key")!.value;
    expect(raw.startsWith("v1.")).toBe(true);
    expect(raw).not.toContain("re_stored");
    expect(await getResendApiKey(e)).toBe("re_stored_abcdefgh");
    const s = await credentialStatus(e, "apiKey");
    expect(s).toMatchObject({ configured: true, source: "app", masked: "re_••••••efgh", unreadable: false });
  });

  it("keeps the two credentials apart and invalidates the cache on change", async () => {
    const e = env();
    await storeCredential(e, "webhookSecret", "whsec_abcdefghijklmnop", "u1");
    expect(await getWebhookSecret(e)).toBe("whsec_abcdefghijklmnop");
    expect(await getResendApiKey(e)).toBeUndefined();
    await clearCredential(e, "webhookSecret");
    expect(await getWebhookSecret(e)).toBeUndefined();
  });

  it("reports a value sealed under another SESSION_SECRET as unreadable", async () => {
    const db = fakeDb() as unknown as D1Database;
    await storeCredential(env({ DB: db }), "apiKey", "re_stored_abcdefgh", "u1");
    invalidateProviderConfig();
    const rotated = env({ DB: db, SESSION_SECRET: "a-different-secret-entirely-000000" });
    expect(await getResendApiKey(rotated)).toBeUndefined();
    expect(await credentialStatus(rotated, "apiKey")).toMatchObject({ configured: false, source: "app", unreadable: true });
  });
});

describe("setup key", () => {
  it("accepts SETUP_TOKEN when set, and not SESSION_SECRET then", async () => {
    const e = { SETUP_TOKEN: "setup-token-xyz", SESSION_SECRET: "session-secret" };
    expect(setupKeySource(e)).toBe("SETUP_TOKEN");
    expect(await setupKeyMatches(e, "setup-token-xyz")).toBe(true);
    expect(await setupKeyMatches(e, "  setup-token-xyz\n")).toBe(true);
    expect(await setupKeyMatches(e, "session-secret")).toBe(false);
  });

  it("falls back to SESSION_SECRET", async () => {
    const e = { SESSION_SECRET: "session-secret" };
    expect(setupKeySource(e)).toBe("SESSION_SECRET");
    expect(await setupKeyMatches(e, "session-secret")).toBe(true);
    expect(await setupKeyMatches(e, "session-secreT")).toBe(false);
    expect(await setupKeyMatches(e, "")).toBe(false);
  });

  it("never matches when no key is configured", async () => {
    expect(await setupKeyMatches({ SESSION_SECRET: "" }, "")).toBe(false);
    expect(await setupKeyMatches({ SESSION_SECRET: "" }, "anything")).toBe(false);
  });
});

describe("first owner", () => {
  it("can only be created once", async () => {
    const db = fakeDb() as unknown as D1Database;
    const [a, b] = await Promise.all([
      createFirstOwner(db, { email: "A@Example.com", name: "A", passwordHash: "x" }),
      createFirstOwner(db, { email: "b@example.com", name: "B", passwordHash: "y" }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });
});

describe("webhook URL", () => {
  it("rejects addresses Resend can't reach", () => {
    expect(webhookUrlProblem("http://localhost:5173")).toMatch(/https/);
    expect(webhookUrlProblem("https://localhost")).toMatch(/can't reach/);
    expect(webhookUrlProblem("not a url")).toMatch(/valid URL/);
    expect(webhookUrlProblem("https://mail.example.com")).toBeNull();
  });
});

describe("setup status", () => {
  const facts: SetupFacts = {
    ownerExists: true,
    useCaseChosen: false,
    brandNamed: false,
    apiKeyConfigured: false,
    primaryDomain: "",
    domains: [],
    webhookConfigured: false,
    mailboxCount: 0,
    userCount: 1,
    testPassed: false,
    completedAt: null,
    skipped: [],
  };

  it("derives steps from real state", () => {
    const steps = deriveSteps(facts);
    expect(steps.owner).toBe("done");
    expect(steps.useCase).toBe("todo");
    expect(nextStep(steps)).toBe("useCase");
    expect(setupProgress(steps)).toBe(11);
  });

  it("counts domains as done only when every one is verified", () => {
    const partly = deriveSteps({ ...facts, primaryDomain: "a.com", domains: [{ name: "a.com", status: "verified" }, { name: "b.com", status: "pending" }] });
    expect(partly.domains).toBe("todo");
    const all = deriveSteps({ ...facts, primaryDomain: "a.com", domains: [{ name: "a.com", status: "verified" }] });
    expect(all.domains).toBe("done");
    expect(deriveSteps({ ...facts, primaryDomain: "a.com", domains: [{ name: "a.com", status: null }] }).domains).toBe("todo");
  });

  it("passes over skipped steps, but real completion wins over a skip", () => {
    const steps = deriveSteps({ ...facts, useCaseChosen: true, skipped: ["brand", "provider", "useCase"] });
    expect(steps.useCase).toBe("done");
    expect(steps.brand).toBe("skipped");
    expect(nextStep(steps)).toBe("domains");
  });

  it("is done when everything is", () => {
    const steps = deriveSteps({
      ...facts,
      useCaseChosen: true,
      brandNamed: true,
      apiKeyConfigured: true,
      primaryDomain: "a.com",
      domains: [{ name: "a.com", status: "verified" }],
      webhookConfigured: true,
      mailboxCount: 2,
      userCount: 3,
      testPassed: true,
      completedAt: "2026-01-01T00:00:00Z",
    });
    expect(nextStep(steps)).toBe("done");
    expect(setupProgress(steps)).toBe(100);
    expect(steps.done).toBe("done");
  });

  it("sanitizes stored state", () => {
    const s = sanitizeSetupState({ skipped: ["brand", "nope", "brand"], completedAt: 5, webhook: { id: "w" } });
    expect(s.skipped).toEqual(["brand"]);
    expect(s.completedAt).toBeNull();
    expect(s.webhook).toBeNull();
    expect(sanitizeSetupState(null)).toMatchObject({ skipped: [], domains: {}, test: {} });
  });
});
