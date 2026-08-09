import { HTTPException } from "hono/http-exception";
import type { SessionUser } from "../env";
import type { MailboxRole } from "@shared/types";

const RANK: Record<MailboxRole, number> = { viewer: 1, editor: 2, owner: 3 };

export async function mailboxRole(db: D1Database, userId: string, mailboxId: string): Promise<MailboxRole | null> {
  const row = await db
    .prepare(
      `SELECT mm.role FROM mailbox_members mm JOIN mailboxes m ON m.id = mm.mailbox_id
       WHERE mm.mailbox_id = ? AND mm.user_id = ? AND m.is_active = 1`,
    )
    .bind(mailboxId, userId)
    .first<{ role: MailboxRole }>();
  return row?.role ?? null;
}

/**
 * Ensures the user is a member of the mailbox with at least `min` role.
 * Admins are intentionally NOT granted implicit access to other people's mail:
 * they must add themselves as a member, which is audited.
 */
export async function requireMailbox(
  db: D1Database,
  user: SessionUser,
  mailboxId: string,
  min: MailboxRole = "viewer",
): Promise<MailboxRole> {
  const role = await mailboxRole(db, user.id, mailboxId);
  if (!role) throw new HTTPException(404, { message: "Mailbox not found" });
  if (RANK[role] < RANK[min]) throw new HTTPException(403, { message: "You don't have permission to do that in this mailbox" });
  return role;
}

/** Load a message and verify the user can access its mailbox. */
export async function requireMessage<T extends { mailbox_id: string }>(
  db: D1Database,
  user: SessionUser,
  messageId: string,
  min: MailboxRole = "viewer",
): Promise<T> {
  const msg = await db.prepare("SELECT * FROM messages WHERE id = ?").bind(messageId).first<T>();
  if (!msg) throw new HTTPException(404, { message: "Message not found" });
  await requireMailbox(db, user, msg.mailbox_id, min);
  return msg;
}

export async function userMailboxIds(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT mm.mailbox_id FROM mailbox_members mm JOIN mailboxes m ON m.id = mm.mailbox_id
       WHERE mm.user_id = ? AND m.is_active = 1`,
    )
    .bind(userId)
    .all<{ mailbox_id: string }>();
  return results.map((r) => r.mailbox_id);
}
