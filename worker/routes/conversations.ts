import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  CONVERSATION_STATUSES,
  findMentions,
  NOTE_MAX,
  PRESENCE_TTL_MS,
  type CollabCounts,
  type ConversationEvent,
  type ConversationEventType,
  type ConversationInfo,
  type ConversationNote,
  type ConversationStatus,
  type MailboxMember,
  type Person,
} from "@shared/collab";
import type { MailboxRole } from "@shared/types";
import type { AppEnv } from "../env";
import { mailboxRole, requireMailbox, requireMessage } from "../lib/access";
import { audit } from "../lib/audit";
import {
  assignConversation,
  assignmentStatements,
  canDeleteNote,
  canEditNote,
  canWriteConversation,
  conversationAnchor,
  notifyAssigned,
  notifyMentioned,
  setConversationStatus,
  statusStatements,
  type ConversationKey,
} from "../lib/collab";
import { newId, now } from "../lib/util";
import { parseBody, zId } from "../lib/validate";

export const conversationRoutes = new Hono<AppEnv>();

const zThreadId = z.string().min(1).max(200);
const zBody = z.string().trim().min(1, "Write something first").max(NOTE_MAX, `Notes can be up to ${NOTE_MAX} characters`);

const person = (id: string | null, name: string | null, email: string | null, color: string | null): Person | null =>
  id && email ? { id, name: name ?? "", email, color: color ?? "#64748b" } : null;

/** Run after the response so a slow push service never delays the UI. */
function later(c: Context<AppEnv>, p: Promise<unknown>) {
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    void p;
  }
}

async function members(db: D1Database, mailboxId: string): Promise<MailboxMember[]> {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.name, u.email, u.avatar_color, mm.role FROM mailbox_members mm JOIN users u ON u.id = mm.user_id
       WHERE mm.mailbox_id = ? AND u.status <> 'disabled' ORDER BY u.name COLLATE NOCASE, u.email LIMIT 500`,
    )
    .bind(mailboxId)
    .all<{ id: string; name: string; email: string; avatar_color: string; role: MailboxRole }>();
  return results.map((r) => ({ id: r.id, name: r.name, email: r.email, color: r.avatar_color, role: r.role }));
}

/** Resolve the conversation in the URL after checking the caller's role in its mailbox. */
async function conversation(c: Context<AppEnv>, min: MailboxRole) {
  const key: ConversationKey = { mailboxId: c.req.param("mailboxId") ?? "", threadId: c.req.param("threadId") ?? "" };
  if (!zThreadId.safeParse(key.threadId).success) throw new HTTPException(404, { message: "Conversation not found" });
  const role = await requireMailbox(c.env.DB, c.get("user"), key.mailboxId, min);
  return { key, role };
}

/** Badge counts for the sidebar (across every mailbox the user can still open). */
conversationRoutes.get("/counts", async (c) => {
  const u = c.get("user");
  const [assigned, mentions] = await c.env.DB.batch<{ n: number }>([
    c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM conversations cv
       JOIN mailbox_members mm ON mm.mailbox_id = cv.mailbox_id AND mm.user_id = ?1
       JOIN mailboxes m ON m.id = cv.mailbox_id AND m.is_active = 1
       WHERE cv.assignee_id = ?1 AND cv.status <> 'closed'`,
    ).bind(u.id),
    c.env.DB.prepare(
      `SELECT COUNT(DISTINCT cm.mailbox_id || '|' || cm.thread_id) AS n FROM conversation_mentions cm
       JOIN mailbox_members mm ON mm.mailbox_id = cm.mailbox_id AND mm.user_id = cm.user_id
       JOIN mailboxes m ON m.id = cm.mailbox_id AND m.is_active = 1
       WHERE cm.user_id = ? AND cm.seen_at IS NULL`,
    ).bind(u.id),
  ]);
  return c.json<CollabCounts>({ assigned: assigned.results[0]?.n ?? 0, mentions: mentions.results[0]?.n ?? 0 });
});

/** People who can be assigned or @mentioned in a mailbox. Any member may see who else is on it. */
conversationRoutes.get("/members/:mailboxId", async (c) => {
  const mailboxId = c.req.param("mailboxId");
  await requireMailbox(c.env.DB, c.get("user"), mailboxId);
  return c.json(await members(c.env.DB, mailboxId));
});

/** Everything the reading pane shows besides the messages: status, assignee, notes, activity, who's replying. */
conversationRoutes.get("/t/:mailboxId/:threadId", async (c) => {
  const { key, role } = await conversation(c, "viewer");
  const u = c.get("user");
  const db = c.env.DB;
  const t = now();
  const [conv, notes, events, replying] = await db.batch([
    db
      .prepare(
        `SELECT cv.status, u.id, u.name, u.email, u.avatar_color FROM conversations cv LEFT JOIN users u ON u.id = cv.assignee_id
         WHERE cv.mailbox_id = ? AND cv.thread_id = ?`,
      )
      .bind(key.mailboxId, key.threadId),
    db
      .prepare(
        `SELECT n.id, n.author_id, n.body, n.created_at, n.edited_at, u.name, u.email, u.avatar_color
         FROM conversation_notes n LEFT JOIN users u ON u.id = n.author_id
         WHERE n.mailbox_id = ? AND n.thread_id = ? ORDER BY n.created_at LIMIT 500`,
      )
      .bind(key.mailboxId, key.threadId),
    db
      .prepare(
        `SELECT e.id, e.type, e.value, e.created_at, a.id AS a_id, a.name AS a_name, a.email AS a_email, a.avatar_color AS a_color,
           tu.id AS t_id, tu.name AS t_name, tu.email AS t_email, tu.avatar_color AS t_color
         FROM conversation_events e LEFT JOIN users a ON a.id = e.actor_id LEFT JOIN users tu ON tu.id = e.target_user_id
         WHERE e.mailbox_id = ? AND e.thread_id = ? AND e.type <> 'note' ORDER BY e.created_at DESC LIMIT 200`,
      )
      .bind(key.mailboxId, key.threadId),
    db
      .prepare(
        `SELECT u.id, u.name, u.email, u.avatar_color FROM conversation_presence p JOIN users u ON u.id = p.user_id
         WHERE p.mailbox_id = ? AND p.thread_id = ? AND p.user_id <> ? AND p.expires_at > ?`,
      )
      .bind(key.mailboxId, key.threadId, u.id, t),
    // Opening the conversation clears my "Mentions" badge for it.
    db
      .prepare("UPDATE conversation_mentions SET seen_at = ? WHERE mailbox_id = ? AND thread_id = ? AND user_id = ? AND seen_at IS NULL")
      .bind(t, key.mailboxId, key.threadId, u.id),
  ]);
  type U = { id: string | null; name: string | null; email: string | null; avatar_color: string | null };
  const cv = conv.results[0] as (U & { status: ConversationStatus }) | undefined;
  const out: ConversationInfo = {
    mailboxId: key.mailboxId,
    threadId: key.threadId,
    status: cv?.status ?? "open",
    assignee: cv ? person(cv.id, cv.name, cv.email, cv.avatar_color) : null,
    notes: (notes.results as (U & { id: string; author_id: string | null; body: string; created_at: string; edited_at: string | null })[]).map<ConversationNote>(
      (n) => ({
        id: n.id,
        author: person(n.author_id, n.name, n.email, n.avatar_color),
        body: n.body,
        createdAt: n.created_at,
        editedAt: n.edited_at,
        canEdit: canEditNote(n, u.id, role),
        canDelete: canDeleteNote(n, u.id, role),
      }),
    ),
    events: (
      events.results as {
        id: string;
        type: ConversationEventType;
        value: string | null;
        created_at: string;
        a_id: string | null;
        a_name: string | null;
        a_email: string | null;
        a_color: string | null;
        t_id: string | null;
        t_name: string | null;
        t_email: string | null;
        t_color: string | null;
      }[]
    )
      .reverse()
      .map<ConversationEvent>((e) => ({
        id: e.id,
        type: e.type,
        value: e.value,
        createdAt: e.created_at,
        actor: person(e.a_id, e.a_name, e.a_email, e.a_color),
        target: person(e.t_id, e.t_name, e.t_email, e.t_color),
      })),
    replying: (replying.results as U[]).map((r) => person(r.id, r.name, r.email, r.avatar_color)).filter((p): p is Person => !!p),
    canWrite: canWriteConversation(role),
  };
  return c.json(out);
});

conversationRoutes.post("/t/:mailboxId/:threadId/assign", async (c) => {
  const { key } = await conversation(c, "editor");
  const body = await parseBody(c, z.object({ assigneeId: zId.nullable() }));
  const u = c.get("user");
  const r = await assignConversation(c.env.DB, { ...key, assigneeId: body.assigneeId, actorId: u.id });
  if (r.changed && body.assigneeId) {
    const anchor = await conversationAnchor(c.env.DB, key);
    if (anchor) later(c, notifyAssigned(c.env, { assigneeId: body.assigneeId, actor: u, anchor }));
  }
  return c.json({ ok: true, changed: r.changed });
});

conversationRoutes.post("/t/:mailboxId/:threadId/status", async (c) => {
  const { key } = await conversation(c, "editor");
  const body = await parseBody(c, z.object({ status: z.enum(CONVERSATION_STATUSES) }));
  const r = await setConversationStatus(c.env.DB, { ...key, status: body.status, actorId: c.get("user").id });
  return c.json({ ok: true, changed: r.changed });
});

/** Insert or refresh mention rows for a note, returning who's newly mentioned (they get a push). */
async function syncMentions(db: D1Database, key: ConversationKey, noteId: string, body: string, isNew: boolean): Promise<string[]> {
  const mentioned = findMentions(body, await members(db, key.mailboxId)).slice(0, 50);
  const existing = isNew
    ? new Set<string>()
    : new Set((await db.prepare("SELECT user_id FROM conversation_mentions WHERE note_id = ?").bind(noteId).all<{ user_id: string }>()).results.map((r) => r.user_id));
  const added = mentioned.filter((id) => !existing.has(id));
  const t = now();
  const stmts = added.map((id) =>
    db
      .prepare("INSERT OR IGNORE INTO conversation_mentions (note_id, user_id, mailbox_id, thread_id, seen_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)")
      .bind(noteId, id, key.mailboxId, key.threadId, t),
  );
  for (const id of existing) if (!mentioned.includes(id)) stmts.push(db.prepare("DELETE FROM conversation_mentions WHERE note_id = ? AND user_id = ?").bind(noteId, id));
  if (stmts.length) await db.batch(stmts);
  return added;
}

conversationRoutes.post("/t/:mailboxId/:threadId/notes", async (c) => {
  const { key } = await conversation(c, "editor");
  const body = await parseBody(c, z.object({ body: zBody }));
  const anchor = await conversationAnchor(c.env.DB, key);
  if (!anchor) throw new HTTPException(404, { message: "Conversation not found" });
  const u = c.get("user");
  const id = newId();
  const t = now();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO conversation_notes (id, mailbox_id, thread_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(
      id,
      key.mailboxId,
      key.threadId,
      u.id,
      body.body,
      t,
    ),
    c.env.DB.prepare(
      "INSERT INTO conversation_events (id, mailbox_id, thread_id, actor_id, type, target_user_id, value, created_at) VALUES (?, ?, ?, ?, 'note', NULL, ?, ?)",
    ).bind(newId(), key.mailboxId, key.threadId, u.id, id, t),
  ]);
  const added = await syncMentions(c.env.DB, key, id, body.body, true);
  if (added.length) later(c, notifyMentioned(c.env, { userIds: added, author: u, anchor, body: body.body }));
  return c.json({ ok: true, id });
});

/** Load a note and the caller's role in its mailbox; 404 when they can't see it at all. */
async function loadNote(c: Context<AppEnv>) {
  const note = await c.env.DB.prepare("SELECT id, mailbox_id, thread_id, author_id FROM conversation_notes WHERE id = ?")
    .bind(c.req.param("id"))
    .first<{ id: string; mailbox_id: string; thread_id: string; author_id: string | null }>();
  const role = note ? await mailboxRole(c.env.DB, c.get("user").id, note.mailbox_id) : null;
  if (!note || !role) throw new HTTPException(404, { message: "Note not found" });
  return { note, role };
}

conversationRoutes.patch("/notes/:id", async (c) => {
  const { note, role } = await loadNote(c);
  const u = c.get("user");
  if (!canEditNote(note, u.id, role)) throw new HTTPException(403, { message: "You can only edit your own notes." });
  const body = await parseBody(c, z.object({ body: zBody }));
  await c.env.DB.prepare("UPDATE conversation_notes SET body = ?, edited_at = ? WHERE id = ?").bind(body.body, now(), note.id).run();
  const key = { mailboxId: note.mailbox_id, threadId: note.thread_id };
  const added = await syncMentions(c.env.DB, key, note.id, body.body, false);
  if (added.length) {
    const anchor = await conversationAnchor(c.env.DB, key);
    if (anchor) later(c, notifyMentioned(c.env, { userIds: added, author: u, anchor, body: body.body }));
  }
  return c.json({ ok: true });
});

conversationRoutes.delete("/notes/:id", async (c) => {
  const { note, role } = await loadNote(c);
  const u = c.get("user");
  if (!canDeleteNote(note, u.id, role)) throw new HTTPException(403, { message: "Only the author or a mailbox owner can delete this note." });
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM conversation_notes WHERE id = ?").bind(note.id),
    c.env.DB.prepare(
      "INSERT INTO conversation_events (id, mailbox_id, thread_id, actor_id, type, target_user_id, value, created_at) VALUES (?, ?, ?, ?, 'note_deleted', ?, NULL, ?)",
    ).bind(newId(), note.mailbox_id, note.thread_id, u.id, note.author_id, now()),
  ]);
  if (note.author_id !== u.id) {
    await audit(c, { action: "conversation.note_deleted", targetType: "mailbox", targetId: note.mailbox_id, meta: { noteId: note.id, authorId: note.author_id } });
  }
  return c.json({ ok: true });
});

// ---- "Someone is replying" ------------------------------------------------------

/** Called by an open reply composer every ~20s; the marker lapses on its own 60s after the last call. */
conversationRoutes.post("/presence", async (c) => {
  const body = await parseBody(c, z.object({ messageId: zId }));
  const u = c.get("user");
  const m = await requireMessage<{ mailbox_id: string; thread_id: string }>(c.env.DB, u, body.messageId, "editor");
  const t = now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO conversation_presence (mailbox_id, thread_id, user_id, expires_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (mailbox_id, thread_id, user_id) DO UPDATE SET expires_at = excluded.expires_at`,
    ).bind(m.mailbox_id, m.thread_id, u.id, new Date(Date.now() + PRESENCE_TTL_MS).toISOString()),
    // Housekeeping instead of a cron: stale markers are swept whenever anyone starts replying.
    c.env.DB.prepare("DELETE FROM conversation_presence WHERE expires_at <= ?").bind(t),
  ]);
  return c.json({ ok: true });
});

conversationRoutes.delete("/presence", async (c) => {
  const body = await parseBody(c, z.object({ messageId: zId }));
  const u = c.get("user");
  const m = await c.env.DB.prepare("SELECT mailbox_id, thread_id FROM messages WHERE id = ?").bind(body.messageId).first<{ mailbox_id: string; thread_id: string }>();
  // Only ever deletes the caller's own marker, so no role check is needed.
  if (m) await c.env.DB.prepare("DELETE FROM conversation_presence WHERE mailbox_id = ? AND thread_id = ? AND user_id = ?").bind(m.mailbox_id, m.thread_id, u.id).run();
  return c.json({ ok: true });
});

// ---- Bulk -----------------------------------------------------------------------

/** Assign or set the status of the conversations of many messages at once (list selection). */
conversationRoutes.post("/bulk", async (c) => {
  const body = await parseBody(
    c,
    z
      .object({
        ids: z.array(zId).min(1).max(200),
        assigneeId: zId.nullable().optional(),
        status: z.enum(CONVERSATION_STATUSES).optional(),
      })
      .refine((b) => b.assigneeId !== undefined || b.status !== undefined, "Nothing to change"),
  );
  const u = c.get("user");
  const db = c.env.DB;
  const pairs = new Map<string, ConversationKey & { messageId: string }>();
  for (let i = 0; i < body.ids.length; i += 90) {
    const chunk = body.ids.slice(i, i + 90);
    const { results } = await db
      .prepare(`SELECT id, mailbox_id, thread_id, subject FROM messages WHERE id IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .all<{ id: string; mailbox_id: string; thread_id: string }>();
    for (const r of results) pairs.set(`${r.mailbox_id}|${r.thread_id}`, { mailboxId: r.mailbox_id, threadId: r.thread_id, messageId: r.id });
  }
  if (!pairs.size) throw new HTTPException(404, { message: "Messages not found" });

  const boxes = [...new Set([...pairs.values()].map((p) => p.mailboxId))];
  for (const mb of boxes) {
    const role = await mailboxRole(db, u.id, mb);
    if (!role) throw new HTTPException(404, { message: "Messages not found" });
    if (!canWriteConversation(role)) throw new HTTPException(403, { message: "You have read-only access to this mailbox." });
  }
  if (body.assigneeId) {
    const { results } = await db
      .prepare(
        `SELECT mm.mailbox_id FROM mailbox_members mm JOIN users u ON u.id = mm.user_id
         WHERE mm.user_id = ? AND u.status <> 'disabled' AND mm.mailbox_id IN (${boxes.map(() => "?").join(",")})`,
      )
      .bind(body.assigneeId, ...boxes)
      .all<{ mailbox_id: string }>();
    if (results.length !== boxes.length) throw new HTTPException(400, { message: "That person isn't a member of every selected mailbox." });
  }

  const t = now();
  const stmts: D1PreparedStatement[] = [];
  const assignEventIdx: number[] = [];
  for (const p of pairs.values()) {
    if (body.assigneeId !== undefined) {
      assignEventIdx.push(stmts.length);
      stmts.push(...assignmentStatements(db, p, body.assigneeId, u.id, t));
    }
    if (body.status) stmts.push(...statusStatements(db, p, body.status, u.id, t));
  }
  const results: D1Result[] = [];
  // Keep each statement pair in the same batch so the event check sees the state before its update.
  for (let i = 0; i < stmts.length; i += 100) results.push(...(await db.batch(stmts.slice(i, i + 100))));

  const list = [...pairs.values()];
  const changed = assignEventIdx.map((idx, i) => ((results[idx]?.meta.changes ?? 0) > 0 ? list[i] : null)).filter((p) => !!p);
  if (body.assigneeId && changed.length) {
    const first = changed[0]!;
    const anchor = await conversationAnchor(db, first);
    if (anchor) later(c, notifyAssigned(c.env, { assigneeId: body.assigneeId, actor: u, anchor, count: changed.length }));
  }
  return c.json({ ok: true, count: pairs.size });
});
