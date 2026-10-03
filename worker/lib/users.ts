import { DIGEST_HOURS, migratePreferences, type DigestHours, type Me, type Role, type UserStatus } from "@shared/types";
import type { OrgPolicy } from "@shared/brand";
import { avatarUrl, type ProfileFields } from "@shared/profile";
import { syncDomainAliases } from "./domains";
import { effectiveRole, storedRole } from "./roles";
import { newId, now, parseJson, randomColor } from "./util";

export interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string | null;
  /** Effective role (normalized by `withRole`); the raw column never holds "manager". */
  role: Role;
  is_manager: number;
  status: UserStatus;
  avatar_color: string;
  totp_secret: string | null;
  totp_enabled: number;
  recovery_codes: string | null;
  google_sub: string | null;
  signature_html: string;
  job_title?: string | null;
  phone?: string | null;
  /** Profile (migration 0020). Optional so rows from older code paths still type-check. */
  avatar_key?: string | null;
  bio?: string | null;
  pronouns?: string | null;
  department?: string | null;
  location?: string | null;
  timezone?: string | null;
  website?: string | null;
  preferences: string;
  failed_logins: number;
  locked_until: string | null;
  last_login_at: string | null;
  personal_email: string | null;
  personal_email_verified_at: string | null;
  digest_enabled: number;
  digest_hours: number;
  digest_last_at: string | null;
  digest_next_at: string | null;
  scim_external_id?: string | null;
  created_at: string;
  updated_at: string;
  /** Present when loaded through getUser / getUserByEmail. */
  passkey_count?: number;
}

/** The profile columns of a users row, with empty strings for anything unset. */
export function profileFields(u: Pick<UserRow, "bio" | "pronouns" | "department" | "location" | "timezone" | "website">): ProfileFields {
  return {
    bio: u.bio ?? "",
    pronouns: u.pronouns ?? "",
    department: u.department ?? "",
    location: u.location ?? "",
    timezone: u.timezone ?? "",
    website: u.website ?? "",
  };
}

export function toMe(u: UserRow, policy: OrgPolicy): Me {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    avatarColor: u.avatar_color,
    avatarUrl: avatarUrl(u.id, u.avatar_key),
    ...profileFields(u),
    totpEnabled: !!u.totp_enabled,
    hasPassword: !!u.password_hash,
    googleLinked: !!u.google_sub,
    signatureHtml: u.signature_html,
    jobTitle: u.job_title ?? "",
    phone: u.phone ?? "",
    preferences: migratePreferences(parseJson<unknown>(u.preferences, {})),
    // A passkey (always with user verification) counts as two-factor.
    mustEnroll2fa: policy.require2fa && !u.totp_enabled && !u.passkey_count,
    passkeyCount: u.passkey_count ?? 0,
    personalEmail: u.personal_email ?? null,
    digest: { enabled: !!u.digest_enabled, hours: ((DIGEST_HOURS as readonly number[]).includes(u.digest_hours) ? u.digest_hours : 5) as DigestHours, lastAt: u.digest_last_at ?? null, nextAt: u.digest_next_at ?? null },
    digestsAllowed: policy.digestDetail !== "off",
  };
}

/** Normalize a raw users row so `role` is the effective role. */
export const withRole = <T extends { role: string; is_manager?: number | null }>(r: T | null): (T & { role: Role }) | null =>
  r ? { ...r, role: effectiveRole(r) } : null;

const USER_SELECT = "SELECT u.*, (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS passkey_count FROM users u";
export const getUser = async (db: D1Database, id: string) => withRole(await db.prepare(`${USER_SELECT} WHERE u.id = ?`).bind(id).first<UserRow>());
export const getUserByEmail = async (db: D1Database, email: string) =>
  withRole(await db.prepare(`${USER_SELECT} WHERE u.email = ?`).bind(email.trim().toLowerCase()).first<UserRow>());

/**
 * What disabling an account also does, shared by the admin console and SCIM: sign out
 * everywhere, stop unread-mail reminders to their personal inbox (they'd have to turn it back
 * on themselves), and forget their push devices.
 */
export const offboardStatements = (db: D1Database, userId: string): D1PreparedStatement[] => [
  db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
  db.prepare("UPDATE users SET digest_enabled = 0, digest_next_at = NULL WHERE id = ?").bind(userId),
  db.prepare("DELETE FROM push_subscriptions WHERE user_id = ?").bind(userId),
];

/** The one account a personal mailbox belongs to, or null when there isn't exactly one owner. */
export function soleOwner(ownerIds: readonly string[]): string | null {
  const unique = [...new Set(ownerIds)];
  return unique.length === 1 ? unique[0]! : null;
}

/**
 * The account to sign in for an email someone typed. People usually know their work
 * address (alan@company) rather than the personal email their account was created with,
 * so besides the sign-in email itself this accepts the address, or an alias, of a personal
 * mailbox they own. Shared mailboxes never count, and an exact sign-in email always wins.
 */
export async function getUserForSignIn(db: D1Database, email: string) {
  const direct = await getUserByEmail(db, email);
  if (direct) return direct;
  const { results } = await db
    .prepare(
      `SELECT mm.user_id FROM mailboxes m JOIN mailbox_members mm ON mm.mailbox_id = m.id AND mm.role = 'owner'
       WHERE m.type = 'personal' AND m.is_system = 0 AND m.is_active = 1
         AND (m.address = ?1 OR m.id IN (SELECT mailbox_id FROM mailbox_aliases WHERE address = ?1))`,
    )
    .bind(email.trim().toLowerCase())
    .all<{ user_id: string }>();
  const id = soleOwner(results.map((r) => r.user_id));
  return id ? getUser(db, id) : null;
}

/** Insert a user row; returns the new id. */
export async function insertUser(
  db: D1Database,
  u: { email: string; name: string; role: Role; status: UserStatus; passwordHash?: string | null; googleSub?: string | null },
): Promise<string> {
  const id = newId();
  const t = now();
  const stored = storedRole(u.role);
  await db
    .prepare(
      `INSERT INTO users (id, email, name, password_hash, role, is_manager, status, avatar_color, google_sub, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, u.email.trim().toLowerCase(), u.name.trim(), u.passwordHash ?? null, stored.role, stored.isManager, u.status, randomColor(), u.googleSub ?? null, t, t)
    .run();
  return id;
}

/** Create a mailbox (if the address is free, with its address on every mail domain) and make the user its owner. */
export async function ensureMailbox(
  db: D1Database,
  /** `name` is the sidebar label; defaults to the sender name. */
  opts: { address: string; name?: string; displayName: string; type: "personal" | "shared"; ownerId?: string },
): Promise<string> {
  const address = opts.address.trim().toLowerCase();
  const existing = await db.prepare("SELECT id FROM mailboxes WHERE address = ?").bind(address).first<{ id: string }>();
  const t = now();
  const id = existing?.id ?? newId();
  const stmts: D1PreparedStatement[] = [];
  if (!existing) {
    stmts.push(
      db
        .prepare("INSERT INTO mailboxes (id, address, name, display_name, type, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(id, address, opts.name || opts.displayName, opts.displayName, opts.type, randomColor(), t, t),
    );
  }
  if (opts.ownerId) {
    stmts.push(
      db
        .prepare("INSERT OR IGNORE INTO mailbox_members (mailbox_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)")
        .bind(id, opts.ownerId, t),
    );
  }
  if (stmts.length) await db.batch(stmts);
  if (!existing) await syncDomainAliases(db, id);
  return id;
}
