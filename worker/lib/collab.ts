import { HTTPException } from "hono/http-exception";
import type { ConversationStatus } from "@shared/collab";
import type { MailboxRole } from "@shared/types";
import type { Env } from "../env";
import { pushToUser } from "./push";
import { newId, now } from "./util";

/**
 * Shared-inbox collaboration: who owns a conversation, its open/pending/closed status, and the
 * activity trail. Callers check the actor's permission; these helpers only check data integrity
 * (e.g. the assignee is a member of that mailbox), so automations can reuse them.
 */

export interface ConversationKey {
  mailboxId: string;
  threadId: string;
}

// ---- Permissions (pure, so they're unit-tested) ------------------------------

/** Viewers can read conversations and notes but never change them. */
export const canWriteConversation = (role: MailboxRole | null | undefined): boolean => role === "owner" || role === "editor";

export const canEditNote = (note: { author_id: string | null }, userId: string, role: MailboxRole | null | undefined): boolean =>
  canWriteConversation(role) && !!note.author_id && note.author_id === userId;

/** Authors can delete their own notes; mailbox owners can delete anyone's. */
export const canDeleteNote = (note: { author_id: string | null }, userId: string, role: MailboxRole | null | undefined): boolean =>
  role === "owner" || canEditNote(note, userId, role);

// ---- List filters ----------------------------------------------------------

export const COLLAB_VIEWS = ["assigned", "unassigned", "mentions"] as const;
export type CollabView = (typeof COLLAB_VIEWS)[number];
export const isCollabView = (v: string): v is CollabView => (COLLAB_VIEWS as readonly string[]).includes(v);

/**
 * WHERE fragments for the message list's collaboration views and status chips. Every subquery is
 * scoped to the caller's own mailboxes, so a conversation row can never pull mail from elsewhere.
 * Fragments reference the messages table's bare mailbox_id / thread_id columns.
 */
export function collabFilter(opts: {
  view: string | null;
  status: string | null;
  userId: string;
  mailboxIds: string[];
  hiddenFolders: string;
}): { where: string[]; args: unknown[] } {
  const where: string[] = [];
  const args: unknown[] = [];
  const inBoxes = `(${opts.mailboxIds.map(() => "?").join(",")})`;
  if (!opts.mailboxIds.length) return { where: ["0"], args };
  switch (opts.view) {
    case "assigned":
      where.push(
        `folder NOT IN ${opts.hiddenFolders}`,
        `(mailbox_id, thread_id) IN (SELECT mailbox_id, thread_id FROM conversations WHERE assignee_id = ? AND mailbox_id IN ${inBoxes})`,
      );
      args.push(opts.userId, ...opts.mailboxIds);
      break;
    case "unassigned":
      where.push(
        "folder = 'inbox'",
        `(mailbox_id, thread_id) NOT IN (SELECT mailbox_id, thread_id FROM conversations WHERE assignee_id IS NOT NULL AND mailbox_id IN ${inBoxes})`,
      );
      args.push(...opts.mailboxIds);
      break;
    case "mentions":
      where.push(
        `folder NOT IN ${opts.hiddenFolders}`,
        `(mailbox_id, thread_id) IN (SELECT mailbox_id, thread_id FROM conversation_mentions WHERE user_id = ? AND mailbox_id IN ${inBoxes})`,
      );
      args.push(opts.userId, ...opts.mailboxIds);
      break;
  }
  if (opts.status === "open") {
    // No row means it was never touched, which reads as open.
    where.push(`(mailbox_id, thread_id) NOT IN (SELECT mailbox_id, thread_id FROM conversations WHERE status <> 'open' AND mailbox_id IN ${inBoxes})`);
    args.push(...opts.mailboxIds);
  } else if (opts.status === "pending" || opts.status === "closed") {
    where.push(`(mailbox_id, thread_id) IN (SELECT mailbox_id, thread_id FROM conversations WHERE status = ? AND mailbox_id IN ${inBoxes})`);
    args.push(opts.status, ...opts.mailboxIds);
  }
  return { where, args };
}

// ---- Writes ----------------------------------------------------------------

/** The newest message of a conversation (preferring ones not in Trash/Spam), or null if it doesn't exist. */
export async function conversationAnchor(db: D1Database, k: ConversationKey): Promise<{ id: string; subject: string } | null> {
  return db
    .prepare(
      `SELECT id, subject FROM messages WHERE mailbox_id = ? AND thread_id = ?
       ORDER BY folder IN ('trash','spam'), date DESC LIMIT 1`,
    )
    .bind(k.mailboxId, k.threadId)
    .first<{ id: string; subject: string }>();
}

/** Is this user an active member of the mailbox? */
async function isMember(db: D1Database, mailboxId: string, userId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM mailbox_members mm JOIN users u ON u.id = mm.user_id
       WHERE mm.mailbox_id = ? AND mm.user_id = ? AND u.status <> 'disabled'`,
    )
    .bind(mailboxId, userId)
    .first();
  return !!row;
}

/**
 * Statements that set the assignee and log the change. The event insert runs first and only when
 * the assignee actually changes (a missing row counts as unassigned), so repeats are no-ops.
 */
export function assignmentStatements(db: D1Database, k: ConversationKey, assigneeId: string | null, actorId: string | null, t = now()): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO conversation_events (id, mailbox_id, thread_id, actor_id, type, target_user_id, value, created_at)
         SELECT ?, ?, ?, ?, ?, ?, NULL, ?
         WHERE (SELECT assignee_id FROM conversations WHERE mailbox_id = ? AND thread_id = ?) IS NOT ?`,
      )
      .bind(newId(), k.mailboxId, k.threadId, actorId, assigneeId ? "assigned" : "unassigned", assigneeId, t, k.mailboxId, k.threadId, assigneeId),
    db
      .prepare(
        `INSERT INTO conversations (mailbox_id, thread_id, status, assignee_id, updated_at) VALUES (?, ?, 'open', ?, ?)
         ON CONFLICT (mailbox_id, thread_id) DO UPDATE SET assignee_id = excluded.assignee_id, updated_at = excluded.updated_at
         WHERE conversations.assignee_id IS NOT excluded.assignee_id`,
      )
      .bind(k.mailboxId, k.threadId, assigneeId, t),
  ];
}

/**
 * Assign a conversation to a mailbox member (or unassign with null). The caller must have checked
 * that the actor may do this (editor or owner; actorId null = an automation). Throws 400 if the
 * assignee isn't a member of the mailbox and 404 if the conversation doesn't exist.
 */
export async function assignConversation(
  db: D1Database,
  args: ConversationKey & { assigneeId: string | null; actorId: string | null },
): Promise<{ changed: boolean }> {
  if (!(await conversationAnchor(db, args))) throw new HTTPException(404, { message: "Conversation not found" });
  if (args.assigneeId && !(await isMember(db, args.mailboxId, args.assigneeId))) {
    throw new HTTPException(400, { message: "That person isn't a member of this mailbox." });
  }
  const [evt] = await db.batch(assignmentStatements(db, args, args.assigneeId, args.actorId));
  return { changed: (evt.meta.changes ?? 0) > 0 };
}

/** Statements that set the status and log the change (only when it differs; a missing row counts as open). */
export function statusStatements(db: D1Database, k: ConversationKey, status: ConversationStatus, actorId: string | null, t = now()): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO conversation_events (id, mailbox_id, thread_id, actor_id, type, target_user_id, value, created_at)
         SELECT ?, ?, ?, ?, 'status', NULL, ?, ?
         WHERE COALESCE((SELECT status FROM conversations WHERE mailbox_id = ? AND thread_id = ?), 'open') <> ?`,
      )
      .bind(newId(), k.mailboxId, k.threadId, actorId, status, t, k.mailboxId, k.threadId, status),
    db
      .prepare(
        `INSERT INTO conversations (mailbox_id, thread_id, status, assignee_id, updated_at) VALUES (?, ?, ?, NULL, ?)
         ON CONFLICT (mailbox_id, thread_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
         WHERE conversations.status <> excluded.status`,
      )
      .bind(k.mailboxId, k.threadId, status, t),
  ];
}

export async function setConversationStatus(
  db: D1Database,
  args: ConversationKey & { status: ConversationStatus; actorId: string | null },
): Promise<{ changed: boolean }> {
  if (!(await conversationAnchor(db, args))) throw new HTTPException(404, { message: "Conversation not found" });
  const [evt] = await db.batch(statusStatements(db, args, args.status, args.actorId));
  return { changed: (evt.meta.changes ?? 0) > 0 };
}

/**
 * A new inbound reply puts a pending or closed conversation back in front of the team.
 * Called by inbound mail processing; never throws so mail is always stored.
 */
export async function reopenOnInbound(db: D1Database, k: ConversationKey): Promise<void> {
  try {
    const t = now();
    const row = await db
      .prepare("SELECT status FROM conversations WHERE mailbox_id = ? AND thread_id = ?")
      .bind(k.mailboxId, k.threadId)
      .first<{ status: ConversationStatus }>();
    if (!row || row.status === "open") return;
    await db.batch(statusStatements(db, k, "open", null, t));
  } catch (err) {
    console.error("reopen failed", err);
  }
}

// ---- Notifications ---------------------------------------------------------

/** Push "X assigned you …" to the new assignee (not when you take it yourself). Never throws. */
export async function notifyAssigned(
  env: Env,
  args: { assigneeId: string; actor: { id: string; name: string; email: string } | null; anchor: { id: string; subject: string }; count?: number },
): Promise<void> {
  if (args.actor?.id === args.assigneeId) return;
  try {
    const who = args.actor ? args.actor.name || args.actor.email : "An automation";
    const n = args.count ?? 1;
    await pushToUser(env, args.assigneeId, {
      title: n > 1 ? `${who} assigned you ${n} conversations` : `${who} assigned you a conversation`,
      body: (args.anchor.subject || "(no subject)").slice(0, 140),
      url: `/mail/all/assigned/${args.anchor.id}`,
      tag: `assign-${args.anchor.id}`,
    });
  } catch (err) {
    console.error("assign push failed", err);
  }
}

/** Push "X mentioned you" to each mentioned person except the author. Never throws. */
export async function notifyMentioned(
  env: Env,
  args: { userIds: string[]; author: { id: string; name: string; email: string }; anchor: { id: string; subject: string }; body: string },
): Promise<void> {
  const who = args.author.name || args.author.email;
  const snippet = args.body.replace(/\s+/g, " ").trim();
  await Promise.allSettled(
    args.userIds
      .filter((id) => id !== args.author.id)
      .map((id) =>
        pushToUser(env, id, {
          title: `${who} mentioned you`.slice(0, 80),
          body: `${args.anchor.subject || "(no subject)"}: ${snippet}`.slice(0, 140),
          url: `/mail/all/mentions/${args.anchor.id}`,
          tag: `mention-${args.anchor.id}`,
        }),
      ),
  );
}
