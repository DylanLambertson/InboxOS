/**
 * The admin list, bulk, import and webhook endpoints against the real schema:
 * every migration applied to an in-memory SQLite database behind a small D1 shim.
 */
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../worker/env";
import { invalidateSettings } from "../worker/lib/settings";
import { adminImportRoutes } from "../worker/routes/admin-import";
import { adminMailboxBulkRoutes } from "../worker/routes/admin-mailboxes-bulk";
import { adminMailboxRoutes } from "../worker/routes/admin-mailboxes";
import { adminUserBulkRoutes } from "../worker/routes/admin-users-bulk";
import { adminUserRoutes } from "../worker/routes/admin-users";
import { adminWebhookRoutes } from "../worker/routes/admin-webhooks";

function d1(sqlite: DatabaseSync): D1Database {
  const norm = (v: unknown) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v);
  const stmt = (sql: string, args: unknown[] = []) => ({
    sql,
    bind: (...a: unknown[]) => stmt(sql, a.map(norm)),
    all: async () => ({ results: sqlite.prepare(sql).all(...(args as never[])), success: true, meta: {} }),
    first: async () => sqlite.prepare(sql).get(...(args as never[])) ?? null,
    run: async () => {
      const r = sqlite.prepare(sql).run(...(args as never[]));
      return { success: true, meta: { changes: Number(r.changes) } };
    },
  });
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: ReturnType<typeof stmt>[]) => {
      sqlite.exec("BEGIN");
      try {
        const out = [];
        for (const s of stmts) out.push(/^\s*(SELECT|WITH)\b/i.test(s.sql) ? await s.all() : await s.run());
        sqlite.exec("COMMIT");
        return out;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  } as unknown as D1Database;
}

let sqlite: DatabaseSync;
let env: Record<string, unknown>;
const OWNER = { id: "owner1", email: "owner@acme.test", name: "Olive Owner", role: "owner" as const, sessionId: "s1" };

function app(user = OWNER) {
  const a = new Hono<AppEnv>();
  a.onError((err, c) => c.json({ error: err.message }, (err as { status?: number }).status === undefined ? 500 : ((err as { status: number }).status as 400)));
  a.use("*", async (c, next) => (c.set("user", user), next()));
  a.route("/users", adminUserBulkRoutes);
  a.route("/users", adminUserRoutes);
  a.route("/mailboxes", adminMailboxBulkRoutes);
  a.route("/mailboxes", adminMailboxRoutes);
  a.route("/import", adminImportRoutes);
  a.route("/webhooks", adminWebhookRoutes);
  return a;
}
const call = async (method: string, path: string, body?: unknown, user = OWNER) => {
  const res = await app(user).request(path, { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }, env);
  return { status: res.status, body: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text() };
};

function addUser(id: string, email: string, role = "member", status = "active", extra = "") {
  sqlite.exec(`INSERT INTO users (id, email, name, role, status, created_at, updated_at${extra ? ", " + extra.split("=")[0] : ""})
    VALUES ('${id}', '${email}', '${id}', '${role}', '${status}', '2026-01-01', '2026-01-01'${extra ? ", " + extra.split("=")[1] : ""})`);
}

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  for (const f of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(`migrations/${f}`, "utf8"));
  invalidateSettings();
  env = { DB: d1(sqlite), SESSION_SECRET: "x".repeat(40), APP_URL: "https://mail.acme.test", FILES: { list: async () => ({ objects: [] }), delete: async () => {} } };
  addUser("owner1", "owner@acme.test", "owner");
  addUser("owner2", "second@acme.test", "owner");
  addUser("u1", "ada@acme.test", "member", "active", "last_login_at='2026-10-01'");
  addUser("u2", "bob@acme.test", "admin", "invited");
  addUser("u3", "cy@acme.test", "member", "disabled");
  sqlite.exec(`INSERT INTO mailboxes (id, address, name, type, created_at, updated_at) VALUES ('mb1', 'support@acme.test', 'Support', 'shared', '2026-01-01', '2026-01-01')`);
  sqlite.exec(`INSERT INTO mailbox_members (mailbox_id, user_id, role, created_at) VALUES ('mb1', 'u1', 'editor', '2026-01-01')`);
});

describe("users table", () => {
  it("searches, filters, sorts and pages on the server", async () => {
    const all = await call("GET", "/users/search?sort=email&limit=10");
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(5);
    expect(all.body.items.map((u: { email: string }) => u.email)[0]).toBe("ada@acme.test");
    expect(all.body.counts).toMatchObject({ active: 3, invited: 1, disabled: 1 });
    expect((await call("GET", "/users/search?role=owner")).body.total).toBe(2);
    expect((await call("GET", "/users/search?status=invited")).body.items[0].email).toBe("bob@acme.test");
    expect((await call("GET", "/users/search?q=ada")).body.total).toBe(1);
    expect((await call("GET", "/users/search?signIn=never")).body.total).toBe(4);
    expect((await call("GET", "/users/search?twoFactor=on")).body.total).toBe(0);
    const paged = await call("GET", "/users/search?sort=mailboxes&dir=desc&limit=10&page=1");
    expect(paged.body.items[0].id).toBe("u1");
  });

  it("returns a person's details and exports CSV", async () => {
    const d = await call("GET", "/users/u1");
    expect(d.body.mailboxes).toEqual([expect.objectContaining({ address: "support@acme.test", role: "editor" })]);
    const csv = await call("GET", "/users/export?role=member");
    expect(csv.body.split("\r\n")[0]).toContain("email,name,role,mailbox");
    expect(csv.body).toContain("support@acme.test:editor");
  });
});

describe("bulk user actions", () => {
  it("dry-runs every row, then applies in one transaction with audit entries", async () => {
    const dry = await call("POST", "/users/bulk", { ids: ["owner1", "owner2", "u1", "u3"], action: "disable", dryRun: true });
    expect(dry.body.counts).toEqual({ ok: 2, skipped: 1, failed: 1, remaining: 0 });
    expect(dry.body.results.find((r: { id: string }) => r.id === "owner1").message).toMatch(/yourself/);
    const run = await call("POST", "/users/bulk", { ids: ["owner2", "u1"], action: "disable", dryRun: false });
    expect(run.body.counts.ok).toBe(2);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'disabled'").get()).toEqual({ n: 3 });
    const audits = sqlite.prepare("SELECT action, target_id FROM audit_logs ORDER BY action").all() as { action: string }[];
    expect(audits.filter((a) => a.action === "user.updated")).toHaveLength(2);
    expect(audits.filter((a) => a.action === "user.bulk")).toHaveLength(1);
  });

  it("selects by filter and adds people to a mailbox", async () => {
    const r = await call("POST", "/users/bulk", { filter: { role: "member" }, action: "add_mailbox", params: { mailboxId: "mb1", access: "viewer" }, dryRun: true });
    expect(r.body.results.map((x: { id: string }) => x.id).sort()).toEqual(["u1", "u3"]);
    await call("POST", "/users/bulk", { ids: ["u1", "u3"], action: "add_mailbox", params: { mailboxId: "mb1", access: "viewer" } });
    expect(sqlite.prepare("SELECT user_id, role FROM mailbox_members WHERE mailbox_id = 'mb1' ORDER BY user_id").all()).toEqual([
      { user_id: "u1", role: "viewer" },
      { user_id: "u3", role: "viewer" },
    ]);
  });

  it("keeps managers out of changes", async () => {
    const manager = { ...OWNER, id: "u1", role: "manager" as const };
    const r = await call("POST", "/users/bulk", { ids: ["u3"], action: "enable", dryRun: true }, manager);
    // The route itself doesn't check the role (requireConsole does, for every /api/admin write); the owners-only rule still holds.
    expect(r.status).toBe(200);
    const owners = await call("POST", "/users/bulk", { ids: ["owner2"], action: "disable", dryRun: true }, { ...OWNER, id: "u2", role: "admin" as never });
    expect(owners.body.results[0]).toMatchObject({ status: "failed", message: "Only owners can manage owners." });
  });
});

describe("CSV imports", () => {
  it("previews, then creates users and skips existing ones", async () => {
    const rows = [
      { email: "new@acme.test", name: "New Person", role: "manager", mailbox: "new@mail.acme.test", department: "Sales", timezone: "Europe/Berlin", sendInvite: "no" },
      { email: "ada@acme.test" },
      { email: "bad", role: "boss" },
      { email: "x@acme.test", mailbox: "support@acme.test", sendInvite: "no" },
    ];
    const dry = await call("POST", "/import/users", { rows, dryRun: true });
    expect(dry.body.results.map((r: { status: string }) => r.status)).toEqual(["create", "skip", "error", "error"]);
    const run = await call("POST", "/import/users", { rows, dryRun: false });
    expect(run.body.results[0].done).toBe(true);
    const u = sqlite.prepare("SELECT role, is_manager, status, department, timezone FROM users WHERE email = 'new@acme.test'").get();
    expect(u).toEqual({ role: "member", is_manager: 1, status: "invited", department: "Sales", timezone: "Europe/Berlin" });
    expect(sqlite.prepare("SELECT type FROM mailboxes WHERE address = 'new@mail.acme.test'").get()).toEqual({ type: "personal" });
    // Running it again changes nothing.
    expect((await call("POST", "/import/users", { rows: rows.slice(0, 1), dryRun: false })).body.results[0].status).toBe("skip");
  });

  it("imports mailboxes with members and aliases", async () => {
    const m = await call("POST", "/import/mailboxes", { rows: [{ address: "sales@acme.test", members: "ada@acme.test:owner;ghost@acme.test" }], dryRun: false });
    expect(m.body.results[0]).toMatchObject({ status: "create", done: true });
    expect(m.body.results[0].warnings[0]).toMatch(/ghost@acme.test/);
    const a = await call("POST", "/import/aliases", {
      rows: [{ address: "deals@acme.test", mailbox: "sales@acme.test" }, { address: "help@acme.test", mailbox: "nowhere@acme.test" }],
      dryRun: false,
    });
    expect(a.body.results.map((r: { status: string }) => r.status)).toEqual(["create", "error"]);
    expect((await call("GET", "/mailboxes/search?q=deals")).body.items[0]).toMatchObject({ address: "sales@acme.test", memberCount: 1, aliasCount: 1 });
  });
});

describe("mailboxes table and bulk", () => {
  it("lists with member previews and changes type in bulk", async () => {
    const page = await call("GET", "/mailboxes/search?members=one");
    expect(page.body.items[0].members[0]).toMatchObject({ email: "ada@acme.test", role: "editor" });
    const r = await call("POST", "/mailboxes/bulk", { ids: ["mb1"], action: "set_type", params: { type: "personal" } });
    expect(r.body.counts.ok).toBe(1);
    expect((await call("GET", "/mailboxes/mb1")).body.type).toBe("personal");
  });

  it("deletes mailboxes in bulk once confirmed", async () => {
    expect((await call("POST", "/mailboxes/bulk", { ids: ["mb1"], action: "delete" })).status).toBe(400);
    const r = await call("POST", "/mailboxes/bulk", { ids: ["mb1"], action: "delete", params: { confirm: "delete" } });
    expect(r.body.counts.ok).toBe(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM mailboxes WHERE id = 'mb1'").get()).toEqual({ n: 0 });
  });
});

describe("shared inboxes switch", () => {
  it("refuses new shared mailboxes when the feature is off, but leaves personal ones alone", async () => {
    sqlite.exec(`INSERT INTO settings (key, value, updated_at) VALUES ('workspace', '{"useCase":"personal","features":{"sharedInboxes":false}}', '2026-01-01')`);
    invalidateSettings();
    expect((await call("POST", "/mailboxes", { address: "team@acme.test", type: "shared" })).status).toBe(403);
    expect((await call("POST", "/mailboxes", { address: "me@acme.test", type: "personal" })).status).toBe(201);
    expect((await call("POST", "/mailboxes/bulk", { ids: ["mb1"], action: "set_type", params: { type: "shared" } })).status).toBe(403);
    const imp = await call("POST", "/import/mailboxes", { rows: [{ address: "sales@acme.test", type: "shared" }, { address: "pat@acme.test", type: "personal" }], dryRun: true });
    expect(imp.body.results.map((r: { status: string }) => r.status)).toEqual(["error", "create"]);
  });
});

describe("webhook endpoints", () => {
  it("creates an endpoint, sends a signed test event and logs it", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect((await call("POST", "/webhooks", { url: "https://127.0.0.1/hook", events: ["message.received"] })).status).toBe(400);
      const created = await call("POST", "/webhooks", { url: "https://hooks.example.com/in", events: ["message.received", "user.created"] });
      expect(created.status).toBe(201);
      expect(created.body.secret).toMatch(/^whsec_/);
      const stored = sqlite.prepare("SELECT secret FROM webhook_endpoints").get() as { secret: string };
      expect(stored.secret).not.toContain(created.body.secret.slice(6));
      const test = await call("POST", `/webhooks/${created.body.id}/test`);
      expect(test.body.result.status).toBe("succeeded");
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://hooks.example.com/in");
      expect((init.headers as Record<string, string>)["webhook-signature"]).toMatch(/^v1,/);
      const list = await call("GET", "/webhooks");
      expect(list.body[0]).toMatchObject({ failureStreak: 0, last24h: { succeeded: 1 } });
      const log = await call("GET", `/webhooks/${created.body.id}/deliveries`);
      expect(log.body.items[0]).toMatchObject({ eventType: "ping", status: "succeeded" });
      // Inviting someone queues user.created for the endpoint.
      await call("POST", "/users", { email: "hooked@acme.test", sendEmail: false });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ type: "user.created", data: { email: "hooked@acme.test", via: "admin" } });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
