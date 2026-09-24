import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeEvent, findMentions, mentionHandle, noteSegments, type Person } from "../shared/collab";
import {
  assignConversation,
  canDeleteNote,
  canEditNote,
  canWriteConversation,
  collabFilter,
  reopenOnInbound,
  setConversationStatus,
} from "../worker/lib/collab";

const members = [
  { id: "u1", email: "dylan@example.com" },
  { id: "u2", email: "priya.k@example.com" },
  { id: "u3", email: "sam@other.co" },
];

describe("mentions", () => {
  it("uses the address local part as the handle", () => {
    expect(mentionHandle("Priya.K@example.com")).toBe("priya.k");
  });
  it("finds only members, case-insensitively, ignoring emails and trailing punctuation", () => {
    expect(findMentions("Hey @Dylan and @priya.k. can you look?", members).sort()).toEqual(["u1", "u2"]);
    expect(findMentions("mail sam@other.co about it", members)).toEqual([]);
    expect(findMentions("@nobody here", members)).toEqual([]);
    expect(findMentions("@dylan @dylan", members)).toEqual(["u1"]);
  });
  it("uses the full address when two members share a local part", () => {
    const twins = [...members, { id: "u4", email: "dylan@other.co" }];
    expect(findMentions("@dylan", twins)).toEqual([]);
    expect(findMentions("ping @dylan@other.co.", twins)).toEqual(["u4"]);
    expect(findMentions("@sam", twins)).toEqual(["u3"]);
  });
});

describe("noteSegments", () => {
  const handles = new Set(["dylan", "priya.k"]);
  it("splits links and known mentions, leaving everything else as text", () => {
    expect(noteSegments("See https://x.co/a?b=1. Thanks @dylan!", handles)).toEqual([
      { kind: "text", text: "See " },
      { kind: "link", text: "https://x.co/a?b=1", href: "https://x.co/a?b=1" },
      { kind: "text", text: ". Thanks " },
      { kind: "mention", text: "@dylan", handle: "dylan" },
      { kind: "text", text: "!" },
    ]);
  });
  it("never turns markup or non-http schemes into anything but text", () => {
    const segs = noteSegments('<img src=x onerror=alert(1)> javascript:alert(1) @stranger', handles);
    expect(segs).toEqual([{ kind: "text", text: '<img src=x onerror=alert(1)> javascript:alert(1) @stranger' }]);
  });
  it("round-trips the original text", () => {
    const body = "a @priya.k, b http://e.x/y) c\n@dylan";
    expect(noteSegments(body, handles).map((s) => s.text).join("")).toBe(body);
  });
});

describe("permissions", () => {
  const note = { author_id: "u1" };
  it("lets editors and owners write, never viewers", () => {
    expect(canWriteConversation("owner")).toBe(true);
    expect(canWriteConversation("editor")).toBe(true);
    expect(canWriteConversation("viewer")).toBe(false);
    expect(canWriteConversation(null)).toBe(false);
  });
  it("lets authors edit their own notes only while they can still write", () => {
    expect(canEditNote(note, "u1", "editor")).toBe(true);
    expect(canEditNote(note, "u1", "viewer")).toBe(false);
    expect(canEditNote(note, "u2", "owner")).toBe(false);
    expect(canEditNote({ author_id: null }, "u1", "owner")).toBe(false);
  });
  it("lets mailbox owners delete anyone's note", () => {
    expect(canDeleteNote(note, "u2", "owner")).toBe(true);
    expect(canDeleteNote(note, "u2", "editor")).toBe(false);
    expect(canDeleteNote(note, "u1", "editor")).toBe(true);
    expect(canDeleteNote(note, "u1", "viewer")).toBe(false);
  });
});

describe("describeEvent", () => {
  const dylan: Person = { id: "u1", name: "Dylan", email: "dylan@x", color: "#000" };
  const priya: Person = { id: "u2", name: "Priya", email: "priya@x", color: "#000" };
  it("reads naturally", () => {
    expect(describeEvent({ type: "assigned", actor: dylan, target: priya, value: null })).toBe("Dylan assigned this to Priya");
    expect(describeEvent({ type: "assigned", actor: dylan, target: dylan, value: null })).toBe("Dylan took this");
    expect(describeEvent({ type: "assigned", actor: dylan, target: priya, value: null }, "u2")).toBe("Dylan assigned this to you");
    expect(describeEvent({ type: "status", actor: null, target: null, value: "open" })).toBe("A new reply reopened this");
    expect(describeEvent({ type: "status", actor: priya, target: null, value: "closed" }, "u2")).toBe("You closed this");
  });
});

describe("collabFilter", () => {
  const base = { userId: "me", mailboxIds: ["mb1", "mb2"], hiddenFolders: "('trash')" };
  const placeholders = (where: string[]) => where.join(" ").split("?").length - 1;
  it("scopes every subquery to the caller's mailboxes", () => {
    for (const view of ["assigned", "unassigned", "mentions"]) {
      for (const status of [null, "open", "pending", "closed"]) {
        const f = collabFilter({ ...base, view, status });
        expect(placeholders(f.where)).toBe(f.args.length);
        for (const w of f.where.filter((x) => x.includes("SELECT"))) expect(w).toContain("mailbox_id IN (?,?)");
      }
    }
  });
  it("matches nothing without mailboxes and ignores unknown statuses", () => {
    expect(collabFilter({ ...base, mailboxIds: [], view: "assigned", status: null }).where).toEqual(["0"]);
    expect(collabFilter({ ...base, view: null, status: "bogus" }).where).toEqual([]);
  });
});

// ---- Against real SQLite (Node 22.5+), through a tiny D1-shaped adapter ----------------------------

type Sqlite = { exec(sql: string): void; prepare(sql: string): { all(...a: unknown[]): unknown[]; run(...a: unknown[]): { changes: number | bigint } } };
const sqliteMod = await import("node:sqlite").catch(() => null);

function d1(db: Sqlite): D1Database {
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => (db.prepare(sql).all(...(args as never[]))[0] as unknown) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(args as never[])), meta: {} }),
    run: async () => ({ results: [], meta: { changes: Number(db.prepare(sql).run(...(args as never[])).changes) } }),
  });
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: ReturnType<typeof stmt>[]) => {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  } as unknown as D1Database;
}

describe.skipIf(!sqliteMod)("collaboration SQL", () => {
  const setup = () => {
    const raw = new sqliteMod!.DatabaseSync(":memory:") as unknown as Sqlite;
    raw.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT, status TEXT DEFAULT 'active', avatar_color TEXT DEFAULT '#000');
      CREATE TABLE mailboxes (id TEXT PRIMARY KEY, is_active INTEGER DEFAULT 1);
      CREATE TABLE mailbox_members (mailbox_id TEXT, user_id TEXT, role TEXT, PRIMARY KEY (mailbox_id, user_id));
      CREATE TABLE messages (id TEXT PRIMARY KEY, mailbox_id TEXT, thread_id TEXT, folder TEXT, subject TEXT DEFAULT '', date TEXT);
      INSERT INTO users (id, email, name) VALUES ('me','me@x','Me'), ('pri','pri@x','Priya'), ('out','out@x','Outsider');
      INSERT INTO mailboxes (id) VALUES ('mb1'), ('mb2');
      INSERT INTO mailbox_members VALUES ('mb1','me','editor'), ('mb1','pri','editor'), ('mb2','out','owner');
      INSERT INTO messages VALUES ('m1','mb1','t1','inbox','Hello','2026-01-01'), ('m2','mb1','t2','inbox','Other','2026-01-02'),
        ('m3','mb2','t1','inbox','Not yours','2026-01-03');
    `);
    raw.exec(readFileSync(new URL("../migrations/0014_collaboration.sql", import.meta.url), "utf8"));
    return { raw, db: d1(raw) };
  };
  const list = (raw: Sqlite, view: string | null, status: string | null, mailboxIds = ["mb1"]) => {
    const f = collabFilter({ view, status, userId: "me", mailboxIds, hiddenFolders: "('trash')" });
    return (raw.prepare(`SELECT id FROM messages WHERE mailbox_id IN (${mailboxIds.map(() => "?").join(",")}) AND ${f.where.join(" AND ") || "1"} ORDER BY id`).all(...(mailboxIds as never[]), ...(f.args as never[])) as { id: string }[]).map((r) => r.id);
  };

  it("assigns only members, logs one event per change, and filters views", async () => {
    const { raw, db } = setup();
    await expect(assignConversation(db, { mailboxId: "mb1", threadId: "t1", assigneeId: "out", actorId: "me" })).rejects.toThrow(/member/);
    await expect(assignConversation(db, { mailboxId: "mb1", threadId: "nope", assigneeId: "me", actorId: "me" })).rejects.toThrow(/not found/);
    expect(await assignConversation(db, { mailboxId: "mb1", threadId: "t1", assigneeId: "me", actorId: "me" })).toEqual({ changed: true });
    expect(await assignConversation(db, { mailboxId: "mb1", threadId: "t1", assigneeId: "me", actorId: "me" })).toEqual({ changed: false });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM conversation_events").all()).toEqual([{ n: 1 }]);

    expect(list(raw, "assigned", null)).toEqual(["m1"]);
    expect(list(raw, "unassigned", null)).toEqual(["m2"]);
    // Same thread id in a mailbox I'm not on never leaks in, even when it's asked about.
    expect(list(raw, "assigned", null, ["mb1", "mb2"])).toEqual(["m1"]);

    expect(await assignConversation(db, { mailboxId: "mb1", threadId: "t1", assigneeId: null, actorId: "me" })).toEqual({ changed: true });
    expect(list(raw, "assigned", null)).toEqual([]);
  });

  it("tracks status, filters chips, and reopens on an inbound reply", async () => {
    const { raw, db } = setup();
    expect(list(raw, null, "open")).toEqual(["m1", "m2"]);
    expect(await setConversationStatus(db, { mailboxId: "mb1", threadId: "t1", status: "open", actorId: "me" })).toEqual({ changed: false });
    await setConversationStatus(db, { mailboxId: "mb1", threadId: "t1", status: "closed", actorId: "me" });
    expect(list(raw, null, "closed")).toEqual(["m1"]);
    expect(list(raw, null, "open")).toEqual(["m2"]);
    await reopenOnInbound(db, { mailboxId: "mb1", threadId: "t1" });
    expect(list(raw, null, "open")).toEqual(["m1", "m2"]);
    const events = raw.prepare("SELECT actor_id, value FROM conversation_events ORDER BY rowid").all();
    expect(events).toEqual([
      { actor_id: "me", value: "closed" },
      { actor_id: null, value: "open" },
    ]);
  });
});
