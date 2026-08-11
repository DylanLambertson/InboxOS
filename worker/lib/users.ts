import { DEFAULT_PREFERENCES, type Me, type Preferences, type Role, type UserStatus } from "@shared/types";
import type { OrgPolicy } from "@shared/brand";
import { newId, now, parseJson, randomColor } from "./util";

export interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string | null;
  role: Role;
  status: UserStatus;
  avatar_color: string;
  totp_secret: string | null;
  totp_enabled: number;
  recovery_codes: string | null;
  google_sub: string | null;
  signature_html: string;
  preferences: string;
  failed_logins: number;
  locked_until: string | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export function toMe(u: UserRow, policy: OrgPolicy): Me {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    avatarColor: u.avatar_color,
    totpEnabled: !!u.totp_enabled,
    hasPassword: !!u.password_hash,
    googleLinked: !!u.google_sub,
    signatureHtml: u.signature_html,
    preferences: { ...DEFAULT_PREFERENCES, ...parseJson<Partial<Preferences>>(u.preferences, {}) },
    mustEnroll2fa: policy.require2fa && !u.totp_enabled,
  };
}

export const getUser = (db: D1Database, id: string) => db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
export const getUserByEmail = (db: D1Database, email: string) =>
  db.prepare("SELECT * FROM users WHERE email = ?").bind(email.trim().toLowerCase()).first<UserRow>();

/** Insert a user row; returns the new id. */
export async function insertUser(
  db: D1Database,
  u: { email: string; name: string; role: Role; status: UserStatus; passwordHash?: string | null; googleSub?: string | null },
): Promise<string> {
  const id = newId();
  const t = now();
  await db
    .prepare(
      `INSERT INTO users (id, email, name, password_hash, role, status, avatar_color, google_sub, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, u.email.trim().toLowerCase(), u.name.trim(), u.passwordHash ?? null, u.role, u.status, randomColor(), u.googleSub ?? null, t, t)
    .run();
  return id;
}

/** Create a mailbox (if the address is free) and make the user its owner. */
export async function ensureMailbox(
  db: D1Database,
  opts: { address: string; displayName: string; type: "personal" | "shared"; ownerId?: string },
): Promise<string> {
  const address = opts.address.trim().toLowerCase();
  const existing = await db.prepare("SELECT id FROM mailboxes WHERE address = ?").bind(address).first<{ id: string }>();
  const t = now();
  const id = existing?.id ?? newId();
  const stmts: D1PreparedStatement[] = [];
  if (!existing) {
    stmts.push(
      db
        .prepare("INSERT INTO mailboxes (id, address, display_name, type, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(id, address, opts.displayName, opts.type, randomColor(), t, t),
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
  return id;
}
