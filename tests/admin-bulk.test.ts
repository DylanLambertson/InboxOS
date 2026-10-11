import { describe, expect, it } from "vitest";
import { BULK_MAX } from "@shared/admin";
import { checkAliasRow, checkMailboxRow, checkUserRow, parseAccess, parseMembers, parseRole, parseYesNo } from "@shared/admin-import";
import { mailboxListSql, planMailboxBulk, type MailboxTarget } from "../worker/lib/mailbox-admin";
import { nextStatus, parseUserFilter, userChangeProblem, userListSql } from "../worker/lib/user-admin";
import { bulkParamsProblem, planUserBulk, type BulkTarget } from "../worker/lib/user-bulk";
import { adminUserBulkRoutes } from "../worker/routes/admin-users-bulk";
import { adminMailboxBulkRoutes } from "../worker/routes/admin-mailboxes-bulk";
import { adminImportRoutes } from "../worker/routes/admin-import";

const owner = { id: "o1", role: "owner" as const };
const admin = { id: "a1", role: "admin" as const };
const person = (id: string, over: Partial<BulkTarget> = {}): BulkTarget => ({ id, email: `${id}@x.co`, name: id, role: "member", status: "active", totpEnabled: false, ...over });
const ctx = (over: Partial<Parameters<typeof planUserBulk>[4]> = {}) => ({ activeOwners: 2, heldUserIds: new Set<string>(), membership: new Map(), ...over });

describe("user change rules", () => {
  it("only owners manage or grant owners", () => {
    expect(userChangeProblem(admin, person("o2", { role: "owner" }), { status: "disabled" }, 3)).toMatch(/Only owners/);
    expect(userChangeProblem(admin, person("m1"), { role: "owner" }, 3)).toMatch(/Only owners can grant/);
    expect(userChangeProblem(owner, person("m1"), { role: "owner" }, 3)).toBeNull();
  });

  it("never lets you lock yourself out", () => {
    expect(userChangeProblem(owner, person("o1", { role: "owner" }), { delete: true }, 3)).toMatch(/delete yourself/);
    expect(userChangeProblem(owner, person("o1", { role: "owner" }), { role: "admin" }, 3)).toMatch(/your own role/);
    expect(userChangeProblem(owner, person("o1", { role: "owner" }), { role: "owner" }, 3)).toBeNull();
  });

  it("keeps at least one active owner", () => {
    expect(userChangeProblem(owner, person("o2", { role: "owner" }), { status: "disabled" }, 1)).toMatch(/at least one active owner/);
    expect(userChangeProblem(owner, person("o2", { role: "owner", status: "invited" }), { delete: true }, 1)).toBeNull();
  });

  it("re-enabled people who never accepted stay invited", () => {
    expect(nextStatus({ status: "disabled", password_hash: null, google_sub: null }, "active")).toBe("invited");
    expect(nextStatus({ status: "disabled", password_hash: "h" }, "active")).toBe("active");
    expect(nextStatus({ status: "invited" }, "disabled")).toBe("disabled");
  });
});

describe("bulk user actions", () => {
  it("validates params per action", () => {
    expect(bulkParamsProblem("role", {})).toBe("Choose a role.");
    expect(bulkParamsProblem("add_mailbox", { mailboxId: "m" })).toBe("Choose an access level.");
    expect(bulkParamsProblem("remove_mailbox", {})).toBe("Choose a mailbox.");
    expect(bulkParamsProblem("disable", {})).toBeNull();
  });

  it("tracks the last active owner across the whole batch", () => {
    const targets = [person("o2", { role: "owner" }), person("o3", { role: "owner" }), person("m1")];
    const plan = planUserBulk(owner, targets, "disable", {}, ctx({ activeOwners: 3 }));
    // o1 (the actor) stays, so both other owners can go.
    expect(plan.map((p) => p.status)).toEqual(["ok", "ok", "ok"]);
    const tight = planUserBulk({ id: "x", role: "owner" }, targets, "delete", {}, ctx({ activeOwners: 2 }));
    expect(tight.map((p) => p.status)).toEqual(["ok", "failed", "ok"]);
    expect(tight[1].message).toMatch(/at least one active owner/);
  });

  it("refuses rows the actor can't touch and skips no-ops, per row", () => {
    const targets = [person("a1", { role: "admin" }), person("o2", { role: "owner" }), person("m1", { role: "manager" }), person("m2")];
    const plan = planUserBulk(admin, targets, "role", { role: "manager" }, ctx());
    expect(plan.map((p) => p.status)).toEqual(["failed", "failed", "skipped", "ok"]);
    expect(plan[0].message).toMatch(/your own role/);
    expect(plan[1].message).toMatch(/Only owners/);
  });

  it("won't delete people under legal hold", () => {
    const plan = planUserBulk(owner, [person("h1"), person("m1")], "delete", {}, ctx({ heldUserIds: new Set(["h1"]) }));
    expect(plan.map((p) => p.status)).toEqual(["failed", "ok"]);
    expect(plan[0].message).toMatch(/legal hold/);
  });

  it("only acts where it would change something", () => {
    expect(planUserBulk(owner, [person("i1", { status: "invited" }), person("m1")], "resend_invite", {}, ctx()).map((p) => p.status)).toEqual(["ok", "skipped"]);
    expect(planUserBulk(owner, [person("t1", { totpEnabled: true }), person("m1")], "reset_2fa", {}, ctx()).map((p) => p.status)).toEqual(["ok", "skipped"]);
    expect(planUserBulk(owner, [person("o1", { role: "owner" }), person("m1")], "sign_out", {}, ctx()).map((p) => p.status)).toEqual(["skipped", "ok"]);
    const membership = new Map([["m1", "editor" as const], ["m2", "viewer" as const]]);
    const add = planUserBulk(owner, [person("m1"), person("m2"), person("m3")], "add_mailbox", { mailboxId: "mb", access: "editor" }, ctx({ membership }));
    expect(add.map((p) => p.status)).toEqual(["skipped", "ok", "ok"]);
    expect(add[1].message).toBe("Access changes from Read only to Can send.");
    expect(planUserBulk(owner, [person("m1"), person("m3")], "remove_mailbox", { mailboxId: "mb" }, ctx({ membership })).map((p) => p.status)).toEqual(["ok", "skipped"]);
  });
});

describe("bulk mailbox actions", () => {
  const box = (id: string, over: Partial<MailboxTarget> = {}): MailboxTarget => ({ id, address: `${id}@x.co`, type: "shared", isActive: true, ...over });
  it("plans each row", () => {
    const held = new Set(["b2"]);
    expect(planMailboxBulk([box("b1"), box("b2")], "delete", {}, { membership: new Map(), held }).map((p) => p.status)).toEqual(["ok", "failed"]);
    expect(planMailboxBulk([box("b1"), box("b2", { type: "personal" })], "set_type", { type: "personal" }, { membership: new Map(), held }).map((p) => p.status)).toEqual(["ok", "skipped"]);
    expect(planMailboxBulk([box("b1"), box("b2", { isActive: false })], "deactivate", {}, { membership: new Map(), held }).map((p) => p.status)).toEqual(["ok", "skipped"]);
    const membership = new Map([["b1", "owner" as const]]);
    expect(planMailboxBulk([box("b1"), box("b2")], "add_member", { userId: "u", access: "owner" }, { membership, held }).map((p) => p.status)).toEqual(["skipped", "ok"]);
  });
});

describe("list queries", () => {
  it("binds every filter value instead of interpolating it", () => {
    const evil = "x' OR 1=1 --";
    const sql = userListSql(parseUserFilter({ q: evil, role: "manager", status: "locked", twoFactor: "off", signIn: "stale90" }), "lastLogin", "desc", "2026-06-01T00:00:00.000Z");
    expect(sql.where).not.toContain(evil);
    expect(sql.binds).toContain(`%${evil}%`);
    expect(sql.binds).toContain("manager");
    expect(sql.binds).toContain("2026-06-01T00:00:00.000Z");
    expect(sql.where).toContain("NOT (u.totp_enabled = 1");
    expect(sql.order).toBe("u.last_login_at IS NULL, u.last_login_at DESC, u.id");
  });

  it("ignores unknown filter values and escapes LIKE wildcards", () => {
    expect(parseUserFilter({ role: "superuser", status: "x", twoFactor: 1 })).toEqual({ q: "", role: "", status: "", twoFactor: "", signIn: "" });
    expect(userListSql({ q: "50%_off" }).binds[0]).toBe("%50\\%\\_off%");
    const m = mailboxListSql({ q: "sales", type: "shared", status: "inactive", members: "none" }, "members", "desc");
    expect(m.where).toContain("m.is_system = 0");
    expect(m.binds).toEqual(["%sales%", "%sales%", "%sales%", "%sales%", "shared"]);
    expect(m.order).toBe("member_count DESC, m.address COLLATE NOCASE, m.id");
  });
});

describe("bulk endpoints validate before touching anything", () => {
  const post = (app: { request: (p: string, i: RequestInit, e: unknown) => Response | Promise<Response> }, path: string, body: unknown) =>
    app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }, { DB: {} });

  it("requires a selection, a known action and its params", async () => {
    expect((await post(adminUserBulkRoutes, "/bulk", { action: "role", params: { role: "admin" } })).status).toBe(400);
    expect((await post(adminUserBulkRoutes, "/bulk", { ids: ["a"], action: "nuke" })).status).toBe(400);
    const res = await post(adminUserBulkRoutes, "/bulk", { ids: ["a"], action: "role" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Choose a role.");
    expect((await post(adminUserBulkRoutes, "/bulk", { ids: Array.from({ length: BULK_MAX + 1 }, (_, i) => `u${i}`), action: "sign_out" })).status).toBe(400);
  });

  it("requires typing delete before deleting mailboxes", async () => {
    const res = await post(adminMailboxBulkRoutes, "/bulk", { ids: ["m"], action: "delete", dryRun: false });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("delete");
  });

  it("caps import size", async () => {
    expect((await post(adminImportRoutes, "/users", { rows: [] })).status).toBe(400);
    expect((await post(adminImportRoutes, "/users", { rows: Array.from({ length: 1001 }, () => ({ email: "a@b.co" })) })).status).toBe(400);
  });
});

describe("import row checks", () => {
  it("parses roles, access, yes/no and member lists", () => {
    expect(parseRole("Admins")).toBe("admin");
    expect(parseRole("")).toBe("member");
    expect(parseRole("god")).toBeNull();
    expect(parseAccess("Read only")).toBe("viewer");
    expect(parseAccess("can send")).toBe("editor");
    expect(parseYesNo("N", true)).toBe(false);
    expect(parseYesNo("maybe", true)).toBeNull();
    expect(parseMembers("a@x.co:owner; b@x.co ;c@x.co:read")).toEqual({
      members: [
        { email: "a@x.co", access: "owner" },
        { email: "b@x.co", access: "editor" },
        { email: "c@x.co", access: "viewer" },
      ],
      problems: [],
    });
    expect(parseMembers("nope:owner;a@x.co:boss").problems).toHaveLength(2);
  });

  it("validates user rows", () => {
    expect(checkUserRow({ email: " Jane@Example.com ", role: "Admin", sendInvite: "no" }).value).toMatchObject({ email: "jane@example.com", role: "admin", sendInvite: false });
    const bad = checkUserRow({ email: "not-an-email", role: "boss", mailbox: "x", sendInvite: "perhaps" });
    expect(bad.value).toBeNull();
    expect(bad.errors).toHaveLength(4);
  });

  it("validates mailbox and alias rows", () => {
    expect(checkMailboxRow({ address: "help@x.co", members: "a@x.co:viewer" }).value).toMatchObject({ type: "shared", members: [{ email: "a@x.co", access: "viewer" }] });
    expect(checkMailboxRow({ address: "help@x.co", type: "team" }).errors[0]).toMatch(/Unknown type/);
    expect(checkAliasRow({ address: "a@x.co", mailbox: "a@x.co" }).errors[0]).toMatch(/itself/);
    expect(checkAliasRow({ address: "a@x.co", mailbox: "b@x.co" }).value).toEqual({ address: "a@x.co", mailbox: "b@x.co" });
  });
});
