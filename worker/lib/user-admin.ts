import type { Role, UserStatus } from "@shared/types";
import { SIGN_IN_FILTERS, USER_SORTS, USER_STATUS_FILTERS, type SortDir, type UserFilter, type UserSort } from "@shared/admin";
import { roleSql } from "./roles";
import { likeEscape } from "./search";

const pick = <T extends string>(allowed: readonly T[], v: unknown): T | "" => (typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : "");

/** A Users filter from query parameters or a JSON body; unknown values are ignored. */
export function parseUserFilter(p: Record<string, unknown>): UserFilter {
  return {
    q: typeof p.q === "string" ? p.q.trim().slice(0, 200) : "",
    role: pick(["owner", "admin", "manager", "member"] as const, p.role),
    status: pick(USER_STATUS_FILTERS, p.status),
    twoFactor: pick(["on", "off"] as const, p.twoFactor),
    signIn: pick(SIGN_IN_FILTERS, p.signIn),
  };
}

export function parseSort<S extends string>(allowed: readonly S[], p: Record<string, unknown>, dflt: S): { sort: S; dir: SortDir } {
  return { sort: pick(allowed, p.sort) || dflt, dir: p.dir === "desc" ? "desc" : "asc" };
}

export const parseUserSort = (p: Record<string, unknown>) => parseSort(USER_SORTS, p, "name");

/**
 * The rules for changing someone's account from the admin console, in one place so
 * the single-user actions and bulk actions can't drift apart.
 */

export interface Actor {
  id: string;
  role: Role;
}

export interface Target {
  id: string;
  role: Role;
  status: UserStatus;
}

export interface UserChange {
  role?: Role;
  status?: "active" | "disabled";
  delete?: boolean;
}

/** Whether `actor` may act on `target` at all (only owners manage owners). */
export function manageProblem(actor: Actor, target: Target): string | null {
  return target.role === "owner" && actor.role !== "owner" ? "Only owners can manage owners." : null;
}

/** Whether this change would take away an active owner. */
export const losesOwner = (target: Target, change: UserChange) =>
  target.role === "owner" && target.status === "active" && (!!change.delete || change.status === "disabled" || (!!change.role && change.role !== "owner"));

/**
 * Why `actor` can't make `change` to `target`, or null when it's allowed.
 * `activeOwners` is how many active owners there are right now.
 */
export function userChangeProblem(actor: Actor, target: Target, change: UserChange, activeOwners: number): string | null {
  const manage = manageProblem(actor, target);
  if (manage) return manage;
  if (change.role === "owner" && actor.role !== "owner") return "Only owners can grant owner.";
  if (target.id === actor.id) {
    if (change.delete) return "You can't delete yourself.";
    if ((change.role && change.role !== target.role) || change.status === "disabled") return "You can't change your own role or disable yourself.";
  }
  if (losesOwner(target, change) && activeOwners <= 1) return "There must always be at least one active owner.";
  return null;
}

/**
 * The status after a change: invited people stay invited until they accept
 * (even when re-enabled), unless being disabled.
 */
export function nextStatus(target: { status: UserStatus; password_hash?: string | null; google_sub?: string | null }, requested?: "active" | "disabled"): UserStatus {
  if (requested === "disabled") return "disabled";
  if (requested === "active" && target.status === "disabled") return target.password_hash || target.google_sub ? "active" : "invited";
  return target.status;
}

// ---- Listing ----------------------------------------------------------------------

/** Two-factor counts as on with an authenticator app or a passkey. */
const TWO_FACTOR_SQL = "(u.totp_enabled = 1 OR EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id = u.id))";
const ROLE_RANK = `CASE ${roleSql("u")} WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'manager' THEN 2 ELSE 3 END`;

/** Sort expressions; the second item is whether the chosen direction applies (fixed ones keep blanks last). */
const USER_ORDER: Record<UserSort, [string, boolean][]> = {
  name: [["CASE WHEN u.name = '' THEN 1 ELSE 0 END", false], ["u.name COLLATE NOCASE", true], ["u.email COLLATE NOCASE", true]],
  email: [["u.email COLLATE NOCASE", true]],
  role: [[ROLE_RANK, true], ["u.name COLLATE NOCASE", false]],
  status: [["CASE u.status WHEN 'active' THEN 0 WHEN 'invited' THEN 1 ELSE 2 END", true], ["u.name COLLATE NOCASE", false]],
  lastLogin: [["u.last_login_at IS NULL", false], ["u.last_login_at", true]],
  created: [["u.created_at", true]],
  mailboxes: [["mailbox_count", true], ["u.name COLLATE NOCASE", false]],
};

/** ORDER BY from sort parts; `tiebreak` keeps pages stable so rows never repeat or vanish between pages. */
export function orderSql(parts: [string, boolean][], dir: SortDir, tiebreak: string): string {
  const d = dir === "desc" ? "DESC" : "ASC";
  return [...parts.map(([expr, directed]) => (directed ? `${expr} ${d}` : expr)), tiebreak].join(", ");
}

export interface SqlParts {
  where: string;
  binds: unknown[];
  order: string;
}

/** WHERE and ORDER BY for the Users table (`u` is users; `mailbox_count` must be selected). */
export function userListSql(f: UserFilter, sort: UserSort = "name", dir: SortDir = "asc", nowIso = new Date().toISOString()): SqlParts {
  const where: string[] = [];
  const binds: unknown[] = [];
  const q = (f.q ?? "").trim().slice(0, 200);
  if (q) {
    const pat = `%${likeEscape(q)}%`;
    where.push(
      `(u.email LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM mailbox_members mm JOIN mailboxes m ON m.id = mm.mailbox_id
         WHERE mm.user_id = u.id AND mm.role = 'owner' AND m.type = 'personal' AND m.address LIKE ? ESCAPE '\\'))`,
    );
    binds.push(pat, pat, pat);
  }
  if (f.role) {
    where.push(`${roleSql("u")} = ?`);
    binds.push(f.role);
  }
  if (f.status === "locked") {
    where.push("u.locked_until > ?");
    binds.push(nowIso);
  } else if (f.status) {
    where.push("u.status = ?");
    binds.push(f.status);
  }
  if (f.twoFactor === "on") where.push(TWO_FACTOR_SQL);
  if (f.twoFactor === "off") where.push(`NOT ${TWO_FACTOR_SQL}`);
  const ago = (days: number) => new Date(Date.parse(nowIso) - days * 86_400_000).toISOString();
  if (f.signIn === "never") where.push("u.last_login_at IS NULL");
  if (f.signIn === "7d" || f.signIn === "30d") {
    where.push("u.last_login_at >= ?");
    binds.push(ago(f.signIn === "7d" ? 7 : 30));
  }
  if (f.signIn === "stale30" || f.signIn === "stale90") {
    where.push("(u.last_login_at IS NULL OR u.last_login_at < ?)");
    binds.push(ago(f.signIn === "stale30" ? 30 : 90));
  }
  return { where: where.length ? `WHERE ${where.join(" AND ")}` : "", binds, order: orderSql(USER_ORDER[sort] ?? USER_ORDER.name, dir, "u.id") };
}
