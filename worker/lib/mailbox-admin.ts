import {
  ACCESS_NAME,
  MAILBOX_SORTS,
  MEMBER_FILTERS,
  type BulkRowStatus,
  type MailboxBulkAction,
  type MailboxBulkParams,
  type MailboxFilter,
  type MailboxSort,
  type SortDir,
} from "@shared/admin";
import type { MailboxRole } from "@shared/types";
import type { Env } from "../env";
import { purgeMessages } from "./messages";
import { getPolicy, saveSetting } from "./settings";
import { likeEscape } from "./search";
import { orderSql, parseSort, type SqlParts } from "./user-admin";

/** Mailbox rules and queries shared by the single and bulk admin actions. */

const pick = <T extends string>(allowed: readonly T[], v: unknown): T | "" => (typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : "");

export function parseMailboxFilter(p: Record<string, unknown>): MailboxFilter {
  return {
    q: typeof p.q === "string" ? p.q.trim().slice(0, 200) : "",
    type: pick(["personal", "shared"] as const, p.type),
    status: pick(["active", "inactive"] as const, p.status),
    members: pick(MEMBER_FILTERS, p.members),
  };
}

export const parseMailboxSort = (p: Record<string, unknown>) => parseSort(MAILBOX_SORTS, p, "address");

const MEMBER_COUNT = "(SELECT COUNT(*) FROM mailbox_members mm WHERE mm.mailbox_id = m.id)";

const MAILBOX_ORDER: Record<MailboxSort, [string, boolean][]> = {
  address: [["m.address COLLATE NOCASE", true]],
  name: [["CASE WHEN m.name = '' THEN 1 ELSE 0 END", false], ["m.name COLLATE NOCASE", true], ["m.address COLLATE NOCASE", false]],
  type: [["m.type", true], ["m.address COLLATE NOCASE", false]],
  members: [["member_count", true], ["m.address COLLATE NOCASE", false]],
  status: [["m.is_active", true], ["m.address COLLATE NOCASE", false]],
  created: [["m.created_at", true]],
};

/** WHERE and ORDER BY for the Mailboxes table (`m` is mailboxes; `member_count` must be selected). */
export function mailboxListSql(f: MailboxFilter, sort: MailboxSort = "address", dir: SortDir = "asc"): SqlParts {
  const where = ["m.is_system = 0"];
  const binds: unknown[] = [];
  const q = (f.q ?? "").trim();
  if (q) {
    const pat = `%${likeEscape(q)}%`;
    where.push(
      `(m.address LIKE ? ESCAPE '\\' OR m.name LIKE ? ESCAPE '\\' OR m.display_name LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM mailbox_aliases a WHERE a.mailbox_id = m.id AND a.address LIKE ? ESCAPE '\\'))`,
    );
    binds.push(pat, pat, pat, pat);
  }
  if (f.type) {
    where.push("m.type = ?");
    binds.push(f.type);
  }
  if (f.status) where.push(f.status === "active" ? "m.is_active = 1" : "m.is_active = 0");
  if (f.members === "none") where.push(`${MEMBER_COUNT} = 0`);
  if (f.members === "one") where.push(`${MEMBER_COUNT} = 1`);
  if (f.members === "many") where.push(`${MEMBER_COUNT} > 1`);
  return { where: `WHERE ${where.join(" AND ")}`, binds, order: orderSql(MAILBOX_ORDER[sort] ?? MAILBOX_ORDER.address, dir, "m.id") };
}

export const MAILBOX_LIST_SELECT = `SELECT m.*, ${MEMBER_COUNT} AS member_count,
  (SELECT COUNT(*) FROM mailbox_aliases a WHERE a.mailbox_id = m.id) AS alias_count FROM mailboxes m`;

export async function addressTaken(db: D1Database, address: string): Promise<boolean> {
  const r = await db.prepare("SELECT 1 FROM mailboxes WHERE address = ?1 UNION SELECT 1 FROM mailbox_aliases WHERE address = ?1").bind(address).first();
  return !!r;
}

export interface MailboxTarget {
  id: string;
  address: string;
  type: "personal" | "shared";
  isActive: boolean;
}

export interface PlannedMailboxRow {
  target: MailboxTarget;
  status: BulkRowStatus;
  message?: string;
}

/** Why the params don't fit the action, or null. */
export function mailboxBulkParamsProblem(action: MailboxBulkAction, p: MailboxBulkParams): string | null {
  if ((action === "add_member" || action === "remove_member") && !p.userId) return "Choose a person.";
  if (action === "add_member" && !p.access) return "Choose an access level.";
  if (action === "set_type" && !p.type) return "Choose a type.";
  return null;
}

/**
 * What a bulk mailbox action will do to each mailbox, decided before anything is written.
 * `membership` is the chosen person's current access per mailbox; `held` are mailboxes under legal hold.
 */
export function planMailboxBulk(
  targets: MailboxTarget[],
  action: MailboxBulkAction,
  params: MailboxBulkParams,
  ctx: { membership: Map<string, MailboxRole>; held: Set<string> },
): PlannedMailboxRow[] {
  return targets.map((t): PlannedMailboxRow => {
    const row = (status: BulkRowStatus, message: string) => ({ target: t, status, message });
    switch (action) {
      case "add_member": {
        const current = ctx.membership.get(t.id);
        if (current === params.access) return row("skipped", "Already has this access.");
        const next = ACCESS_NAME[params.access!];
        return row("ok", current ? `Access changes from ${ACCESS_NAME[current]} to ${next}.` : `Gets ${next} access.`);
      }
      case "remove_member":
        return ctx.membership.has(t.id) ? row("ok", "Loses access.") : row("skipped", "Doesn't have access.");
      case "set_type":
        return t.type === params.type ? row("skipped", `Already ${t.type}.`) : row("ok", `Becomes ${params.type}.`);
      case "activate":
        return t.isActive ? row("skipped", "Already active.") : row("ok", "Sends and receives again.");
      case "deactivate":
        return t.isActive ? row("ok", "Stops sending and receiving.") : row("skipped", "Already inactive.");
      case "delete":
        return ctx.held.has(t.id) ? row("failed", "Under legal hold. Release the hold first (Admin → Compliance).") : row("ok", "Deleted with all its mail.");
    }
  });
}

export const LEGAL_HOLD_MAILBOX ="This mailbox is under legal hold and can't be deleted. Release the hold first (Admin → Compliance).";

/**
 * One step of deleting a mailbox: purge up to `budget` messages, and once none are
 * left remove its files and the mailbox itself. Large mailboxes take several calls.
 * Throws nothing for "held"; callers check that first (it's a refusal, not an error).
 */
export async function deleteMailboxStep(env: Env, id: string, actorId: string | null, budget = 500): Promise<{ done: boolean; purged: number }> {
  const { results } = await env.DB.prepare("SELECT id FROM messages WHERE mailbox_id = ? LIMIT ?").bind(id, budget).all<{ id: string }>();
  if (results.length) await purgeMessages(env.DB, env.FILES, results.map((r) => r.id));
  if (results.length === budget) return { done: false, purged: results.length };
  const orphans = await env.FILES.list({ prefix: `mail/${id}/` });
  if (orphans.objects.length) await env.FILES.delete(orphans.objects.map((o) => o.key));
  await env.DB.prepare("DELETE FROM mailboxes WHERE id = ?").bind(id).run();
  const policy = await getPolicy(env.DB);
  if (policy.catchAllMailboxId === id) await saveSetting(env.DB, "policy", { ...policy, catchAllMailboxId: null }, actorId);
  return { done: true, purged: results.length };
}

