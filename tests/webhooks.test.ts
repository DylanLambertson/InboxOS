import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_DISABLE_AFTER_MS,
  AUTO_DISABLE_STREAK,
  MAX_ATTEMPTS,
  RETRY_SCHEDULE_SECONDS,
  retryDelaySeconds,
  shouldAutoDisable,
  webhookUrlProblem,
} from "@shared/webhooks";
import { verifySvix } from "../worker/lib/svix";
import { sealSecret } from "../worker/lib/secret-box";
import { attemptDelivery, eventBody, generateWebhookSecret, SECRET_PURPOSE, signWebhook, webhookHeaders } from "../worker/lib/webhooks";
import type { Env } from "../worker/env";

describe("Standard Webhooks signing", () => {
  it("matches the spec's published test vector", async () => {
    const sig = await signWebhook("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "msg_p5jXN8AQM9LWM0D4loKWxJek", 1614265330, '{"test": 2432232314}');
    expect(sig).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
  });

  it("produces headers a standard verifier accepts", async () => {
    const secret = generateWebhookSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    const body = eventBody("ping", { message: "hi", endpointId: "e1" });
    const h = await webhookHeaders(secret, "msg_1", body);
    expect(h["webhook-id"]).toBe("msg_1");
    const ok = await verifySvix(secret, { id: h["webhook-id"], timestamp: h["webhook-timestamp"], signature: h["webhook-signature"] }, body);
    expect(ok).toBe(true);
    expect(await verifySvix(secret, { id: "msg_2", timestamp: h["webhook-timestamp"], signature: h["webhook-signature"] }, body)).toBe(false);
  });

  it("wraps every event in the same envelope", () => {
    const body = JSON.parse(eventBody("user.deleted", { id: "u1", email: "a@b.co", name: "A", via: "admin" }, "2026-01-01T00:00:00.000Z"));
    expect(body).toEqual({ type: "user.deleted", timestamp: "2026-01-01T00:00:00.000Z", data: { id: "u1", email: "a@b.co", name: "A", via: "admin" } });
  });
});

describe("retry schedule", () => {
  it("backs off 1m, 5m, 30m, 2h, 6h, 12h, then gives up", () => {
    expect(RETRY_SCHEDULE_SECONDS).toEqual([60, 300, 1800, 7200, 21600, 43200]);
    expect([1, 2, 3, 4, 5, 6].map(retryDelaySeconds)).toEqual([60, 300, 1800, 7200, 21600, 43200]);
    expect(retryDelaySeconds(7)).toBeNull();
    expect(MAX_ATTEMPTS).toBe(7);
    expect(retryDelaySeconds(0)).toBe(0);
  });

  it("auto-disables only after a long streak and days without success", () => {
    const now = Date.parse("2026-06-10T00:00:00Z");
    const old = new Date(now - AUTO_DISABLE_AFTER_MS - 1).toISOString();
    const recent = new Date(now - 3_600_000).toISOString();
    expect(shouldAutoDisable({ failureStreak: AUTO_DISABLE_STREAK, lastSuccessAt: old, createdAt: old }, now)).toBe(true);
    expect(shouldAutoDisable({ failureStreak: AUTO_DISABLE_STREAK - 1, lastSuccessAt: old, createdAt: old }, now)).toBe(false);
    expect(shouldAutoDisable({ failureStreak: 500, lastSuccessAt: recent, createdAt: old }, now)).toBe(false);
    // Never succeeded: counted from when it was created.
    expect(shouldAutoDisable({ failureStreak: 500, lastSuccessAt: null, createdAt: recent }, now)).toBe(false);
    expect(shouldAutoDisable({ failureStreak: 500, lastSuccessAt: null, createdAt: old }, now)).toBe(true);
  });
});

describe("webhook URL safety", () => {
  it("accepts public https URLs", () => {
    for (const ok of ["https://example.com/hook", "https://hooks.example.co.uk:8443/a?b=c", "https://8.8.8.8/x", "https://[2606:4700::1111]/x"]) {
      expect(webhookUrlProblem(ok), ok).toBeNull();
    }
  });

  it("rejects everything else", () => {
    for (const bad of [
      "http://example.com/hook",
      "ftp://example.com",
      "not a url",
      "https://localhost/x",
      "https://api.localhost/x",
      "https://printer.local/x",
      "https://svc.internal/x",
      "https://127.0.0.1/x",
      "https://127.1/x",
      "https://2130706433/x",
      "https://0x7f000001/x",
      "https://10.1.2.3/x",
      "https://172.20.0.1/x",
      "https://192.168.1.1/x",
      "https://169.254.169.254/latest/meta-data",
      "https://100.64.0.1/x",
      "https://0.0.0.0/x",
      "https://[::1]/x",
      "https://[fd00::1]/x",
      "https://[fe80::1]/x",
      "https://[::ffff:127.0.0.1]/x",
      "https://[::ffff:10.0.0.1]/x",
      "https://user:pass@example.com/x",
      "https://intranet/x",
    ]) {
      expect(webhookUrlProblem(bad), bad).not.toBeNull();
    }
  });
});

/** Just enough of D1 for attemptDelivery: one delivery joined to one endpoint. */
function fakeDb(row: Record<string, unknown>) {
  const writes: { sql: string; args: unknown[] }[] = [];
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    run: async () => {
      writes.push({ sql, args });
      return { meta: { changes: 1 } };
    },
    first: async () => (sql.includes("FROM webhook_deliveries d JOIN") ? row : null),
    all: async () => ({ results: [] }),
  });
  const db = { prepare: (sql: string) => stmt(sql), batch: async (s: { run: () => Promise<unknown> }[]) => Promise.all(s.map((x) => x.run())) };
  return { db: db as unknown as D1Database, writes };
}

describe("delivery attempts", () => {
  const SESSION_SECRET = "test-session-secret";
  afterEach(() => vi.unstubAllGlobals());

  async function setup(overrides: Record<string, unknown> = {}) {
    const secret = generateWebhookSecret();
    const row = {
      id: "d1",
      endpoint_id: "e1",
      event_id: "msg_abc",
      payload: eventBody("ping", { message: "x", endpointId: "e1" }),
      attempts: 0,
      url: "https://hooks.example.com/in",
      secret: await sealSecret(SESSION_SECRET, SECRET_PURPOSE, secret),
      enabled: 1,
      failure_streak: 0,
      last_success_at: null,
      endpoint_created_at: new Date().toISOString(),
      ...overrides,
    };
    const { db, writes } = fakeDb(row);
    return { env: { DB: db, SESSION_SECRET } as unknown as Env, writes, secret, row };
  }

  it("signs the request and records a success", async () => {
    const { env, writes, secret, row } = await setup();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      const valid = await verifySvix(secret, { id: h["webhook-id"], timestamp: h["webhook-timestamp"], signature: h["webhook-signature"] }, init.body as string);
      return new Response(valid ? "ok" : "bad signature", { status: valid ? 200 : 401 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const r = await attemptDelivery(env, "d1");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(row.url);
    expect((fetchMock.mock.calls[0][1] as RequestInit).redirect).toBe("manual");
    expect(r?.status).toBe("succeeded");
    expect(writes.some((w) => w.sql.includes("status = 'succeeded'"))).toBe(true);
    expect(writes.some((w) => w.sql.includes("failure_streak = 0"))).toBe(true);
  });

  it("schedules a retry on an error response", async () => {
    const { env, writes } = await setup({ attempts: 2 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const before = Date.now();
    const r = await attemptDelivery(env, "d1");
    expect(r).toMatchObject({ status: "pending", responseStatus: 500, error: "HTTP 500" });
    const update = writes.find((w) => w.sql.includes("UPDATE webhook_deliveries SET status = ?"))!;
    expect(update.args[0]).toBe("pending");
    expect(update.args[1]).toBe(3);
    const next = Date.parse(update.args[2] as string);
    expect(next - before).toBeGreaterThanOrEqual(1800 * 1000 - 50);
  });

  it("gives up after the last attempt and treats redirects as failures", async () => {
    const { env, writes } = await setup({ attempts: MAX_ATTEMPTS - 1 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://10.0.0.1/" } })));
    const r = await attemptDelivery(env, "d1");
    expect(r?.status).toBe("failed");
    expect(r?.error).toMatch(/Redirected/);
    expect(writes.find((w) => w.sql.includes("UPDATE webhook_deliveries SET status = ?"))!.args[0]).toBe("failed");
  });

  it("never calls a URL that became unsafe, or a disabled endpoint", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const a = await setup({ url: "https://169.254.169.254/" });
    expect((await attemptDelivery(a.env, "d1"))?.status).toBe("failed");
    const b = await setup({ enabled: 0 });
    expect((await attemptDelivery(b.env, "d1"))?.error).toMatch(/turned off/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
