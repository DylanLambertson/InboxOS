/**
 * Admin console list filters and bulk actions, shared by the Users and Mailboxes
 * pages and the endpoints behind them so both sides agree on names and limits.
 */
import type { MailboxRole, Role, UserStatus } from "./types";

export type SortDir = "asc" | "desc";

export interface PageOf<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

// ---- Users ----------------------------------------------------------------------

export const USER_SORTS = ["name", "email", "role", "status", "lastLogin", "created", "mailboxes"] as const;
export type UserSort = (typeof USER_SORTS)[number];
export const USER_STATUS_FILTERS = ["active", "invited", "disabled", "locked"] as const;
export const SIGN_IN_FILTERS = ["never", "7d", "30d", "stale30", "stale90"] as const;
export type SignInFilter = (typeof SIGN_IN_FILTERS)[number];

export interface UserFilter {
  q?: string;
  role?: Role | "";
  status?: (typeof USER_STATUS_FILTERS)[number] | "";
  /** Two-factor: TOTP or a passkey counts as on. */
  twoFactor?: "on" | "off" | "";
  signIn?: SignInFilter | "";
}

export const SIGN_IN_LABEL: Record<SignInFilter, string> = {
  never: "Never signed in",
  "7d": "Signed in this week",
  "30d": "Signed in this month",
  stale30: "Not in 30+ days",
  stale90: "Not in 90+ days",
};

export interface AdminUserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  avatarColor: string;
  /** Profile photo, when they uploaded one. */
  avatarUrl: string | null;
  totpEnabled: boolean;
  googleLinked: boolean;
  hasPassword: boolean;
  passkeyCount: number;
  mailboxCount: number;
  lastLoginAt: string | null;
  lockedUntil: string | null;
  /** Unread-mail reminders to a personal address (masked), if on. */
  digest: { hours: number; to: string } | null;
  createdAt: string;
}

export const USER_BULK_ACTIONS = ["role", "disable", "enable", "resend_invite", "reset_2fa", "sign_out", "add_mailbox", "remove_mailbox", "delete"] as const;
export type UserBulkAction = (typeof USER_BULK_ACTIONS)[number];

export const ACCESS_NAME: Record<MailboxRole, string> = { owner: "Owner", editor: "Can send", viewer: "Read only" };

export interface UserBulkParams {
  role?: Role;
  mailboxId?: string;
  access?: MailboxRole;
}

// ---- Mailboxes ------------------------------------------------------------------

export const MAILBOX_SORTS = ["address", "name", "type", "members", "status", "created"] as const;
export type MailboxSort = (typeof MAILBOX_SORTS)[number];
export const MEMBER_FILTERS = ["none", "one", "many"] as const;

export interface MailboxFilter {
  q?: string;
  type?: "personal" | "shared" | "";
  status?: "active" | "inactive" | "";
  members?: (typeof MEMBER_FILTERS)[number] | "";
}

export interface AdminMailboxRow {
  id: string;
  address: string;
  name: string;
  displayName: string;
  type: "personal" | "shared";
  color: string;
  isActive: boolean;
  isCatchAll: boolean;
  legalHold: boolean;
  createdAt: string;
  memberCount: number;
  aliasCount: number;
  /** The first few members, for avatars. */
  members: { userId: string; name: string; email: string; avatarColor: string; avatarUrl: string | null; role: MailboxRole }[];
  messageCount: number;
  storageBytes: number;
  lastActivity: string | null;
}

export const MAILBOX_BULK_ACTIONS = ["add_member", "remove_member", "set_type", "activate", "deactivate", "delete"] as const;
export type MailboxBulkAction = (typeof MAILBOX_BULK_ACTIONS)[number];

export interface MailboxBulkParams {
  userId?: string;
  access?: MailboxRole;
  type?: "personal" | "shared";
  /** Deleting needs `confirm: "delete"` (the console asks for it to be typed). */
  confirm?: string;
}

// ---- Bulk results ---------------------------------------------------------------

/** Most rows a bulk selection may cover (a dry run checks them all at once). */
export const BULK_MAX = 1000;
/** Rows per commit request; the console sends bigger selections in chunks and shows progress. */
export const BULK_CHUNK = 50;
/** Smaller chunks for actions that send email. */
export const BULK_EMAIL_CHUNK = 20;
/** Messages a bulk mailbox delete purges per request; the client repeats until done. */
export const BULK_PURGE_BUDGET = 500;

export type BulkRowStatus = "ok" | "skipped" | "failed" | "remaining";

export interface BulkRowResult {
  id: string;
  label: string;
  status: BulkRowStatus;
  message?: string;
}

export interface BulkResult {
  action: string;
  dryRun: boolean;
  results: BulkRowResult[];
  counts: Record<BulkRowStatus, number>;
}

export function countResults(results: BulkRowResult[]): Record<BulkRowStatus, number> {
  const counts: Record<BulkRowStatus, number> = { ok: 0, skipped: 0, failed: 0, remaining: 0 };
  for (const r of results) counts[r.status]++;
  return counts;
}

/** Query string for a filter, sort and page (empty values left out). */
export function listQuery(params: Record<string, string | number | undefined | null>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  return qs.toString();
}
