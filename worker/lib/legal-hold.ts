/**
 * Legal hold: while a mailbox is held, nothing in it may be permanently deleted
 * by anyone. Every permanent-delete path asks this module, so there is exactly
 * one definition of "held".
 */

export interface ActiveHold {
  id: string;
  mailbox_id: string | null;
  user_id: string | null;
}

export interface HoldState {
  holds: ActiveHold[];
  /** Current memberships of held users. */
  members: { user_id: string; mailbox_id: string }[];
  /** Mailboxes a user hold has covered at some point. */
  snapshots: { hold_id: string; mailbox_id: string }[];
}

/** Every mailbox covered by an active hold. Pure, so it can be tested. */
export function resolveHeldMailboxes(s: HoldState): Set<string> {
  const held = new Set<string>();
  const heldUsers = new Set<string>();
  const holdIds = new Set<string>();
  for (const h of s.holds) {
    holdIds.add(h.id);
    if (h.mailbox_id) held.add(h.mailbox_id);
    if (h.user_id) heldUsers.add(h.user_id);
  }
  for (const m of s.members) if (heldUsers.has(m.user_id)) held.add(m.mailbox_id);
  for (const m of s.snapshots) if (holdIds.has(m.hold_id)) held.add(m.mailbox_id);
  return held;
}

/** Split rows into those that may be deleted and those that must be kept. */
export function partitionHeld<T extends { mailbox_id: string }>(rows: T[], held: Set<string>): { deletable: T[]; kept: T[] } {
  const deletable: T[] = [];
  const kept: T[] = [];
  for (const r of rows) (held.has(r.mailbox_id) ? kept : deletable).push(r);
  return { deletable, kept };
}

export async function heldMailboxIds(db: D1Database): Promise<Set<string>> {
  const active = "SELECT id FROM legal_holds WHERE released_at IS NULL";
  const [holds, members, snapshots] = await db.batch([
    db.prepare("SELECT id, mailbox_id, user_id FROM legal_holds WHERE released_at IS NULL"),
    db.prepare(`SELECT user_id, mailbox_id FROM mailbox_members WHERE user_id IN (SELECT user_id FROM legal_holds WHERE released_at IS NULL AND user_id IS NOT NULL)`),
    db.prepare(`SELECT hold_id, mailbox_id FROM legal_hold_mailboxes WHERE hold_id IN (${active})`),
  ]);
  return resolveHeldMailboxes({
    holds: holds.results as unknown as ActiveHold[],
    members: members.results as unknown as HoldState["members"],
    snapshots: snapshots.results as unknown as HoldState["snapshots"],
  });
}

export async function isHeld(db: D1Database, mailboxId: string): Promise<boolean> {
  return (await heldMailboxIds(db)).has(mailboxId);
}

export async function isUserHeld(db: D1Database, userId: string): Promise<boolean> {
  return !!(await db.prepare("SELECT 1 FROM legal_holds WHERE user_id = ? AND released_at IS NULL").bind(userId).first());
}

/**
 * SQL filter excluding held mailboxes from a bulk query (one bound parameter,
 * so it works no matter how many mailboxes are held).
 */
export const notHeldSql = (column: string, param = "?") => `${column} NOT IN (SELECT value FROM json_each(${param}))`;
export const heldParam = (held: Set<string>) => JSON.stringify([...held]);

/**
 * Before someone leaves a mailbox, remember it on their active holds so the
 * mailbox stays held after the membership is gone.
 */
export function snapshotMembershipStatement(db: D1Database, userId: string, mailboxId: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO legal_hold_mailboxes (hold_id, mailbox_id)
       SELECT id, ? FROM legal_holds WHERE user_id = ? AND released_at IS NULL`,
    )
    .bind(mailboxId, userId);
}
