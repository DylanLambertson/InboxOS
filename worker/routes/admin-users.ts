import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Role, UserStatus } from "@shared/types";
import type { AppEnv, Env, SessionUser } from "../env";
import { audit } from "../lib/audit";
import { isUserHeld } from "../lib/legal-hold";
import { getBrand } from "../lib/settings";
import { templates } from "../lib/email-templates";
import { sendSystemEmail } from "../lib/system-mail";
import { maskEmail } from "../lib/digest";
import { storedRole } from "../lib/roles";
import { ensureMailbox, getUser, getUserByEmail, insertUser, offboardStatements, withRole, type UserRow } from "../lib/users";
import { newId, now, sha256hex } from "../lib/util";
import { parseBody, zEmail } from "../lib/validate";

export const adminUserRoutes = new Hono<AppEnv>();

interface UserListRow extends UserRow {
  mailbox_count: number;
  passkey_count: number;
}

adminUserRoutes.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT u.*, (SELECT COUNT(*) FROM mailbox_members mm WHERE mm.user_id = u.id) AS mailbox_count,
       (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS passkey_count
     FROM users u ORDER BY u.status = 'disabled', u.name COLLATE NOCASE, u.email`,
  ).all<UserListRow>();
  return c.json(
    results.map((row) => withRole(row)!).map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      status: u.status,
      avatarColor: u.avatar_color,
      totpEnabled: !!u.totp_enabled,
      googleLinked: !!u.google_sub,
      hasPassword: !!u.password_hash,
      passkeyCount: u.passkey_count,
      mailboxCount: u.mailbox_count,
      lastLoginAt: u.last_login_at,
      lockedUntil: u.locked_until && u.locked_until > now() ? u.locked_until : null,
      // Masked: admins can see that reminders go outside the company, not the full address.
      digest: u.digest_enabled && u.personal_email ? { hours: u.digest_hours, to: maskEmail(u.personal_email) } : null,
      createdAt: u.created_at,
    })),
  );
});

export async function issueToken(env: Env, userId: string, type: "invite" | "reset", createdBy: string, hours: number): Promise<string> {
  const raw = newId(32);
  await env.DB.batch([
    // Only the newest link of each kind stays valid.
    env.DB.prepare("UPDATE tokens SET used_at = ? WHERE user_id = ? AND type = ? AND used_at IS NULL").bind(now(), userId, type),
    env.DB.prepare("INSERT INTO tokens (id, user_id, type, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(
      await sha256hex(raw),
      userId,
      type,
      new Date(Date.now() + hours * 3_600_000).toISOString(),
      createdBy,
      now(),
    ),
  ]);
  return `${env.APP_URL.replace(/\/$/, "")}/${type === "invite" ? "invite" : "reset"}/${raw}`;
}

export async function emailInvite(env: Env, to: string, url: string, inviter: string, name?: string) {
  const brand = await getBrand(env.DB);
  return sendSystemEmail(env, to, templates.invite(brand, { name, email: to, inviter, url, days: 7 }), "invite");
}

adminUserRoutes.post("/", async (c) => {
  const body = await parseBody(
    c,
    z.object({
      email: zEmail,
      name: z.string().trim().max(120).default(""),
      role: z.enum(["owner", "admin", "manager", "member"]).default("member"),
      mailboxAddress: zEmail.optional(),
      sendEmail: z.boolean().default(true),
      /** Extra mailboxes (e.g. shared inboxes) to grant access to right away. */
      access: z.array(z.object({ mailboxId: z.string().min(1).max(64), role: z.enum(["owner", "editor", "viewer"]) })).max(200).default([]),
    }),
  );
  const actor = c.get("user");
  if (body.role === "owner" && actor.role !== "owner") throw new HTTPException(403, { message: "Only owners can add owners." });
  if (await getUserByEmail(c.env.DB, body.email)) throw new HTTPException(409, { message: "A user with that email already exists." });

  const id = await insertUser(c.env.DB, { email: body.email, name: body.name, role: body.role, status: "invited" });
  let mailboxId: string | null = null;
  if (body.mailboxAddress) {
    mailboxId = await ensureMailbox(c.env.DB, { address: body.mailboxAddress, displayName: body.name, type: "personal", ownerId: id });
  }
  if (body.access.length) {
    const t = now();
    await c.env.DB.batch(
      body.access.map((a) =>
        c.env.DB.prepare(
          `INSERT INTO mailbox_members (mailbox_id, user_id, role, created_at)
           SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM mailboxes WHERE id = ?1 AND is_system = 0)
           ON CONFLICT(mailbox_id, user_id) DO UPDATE SET role = excluded.role`,
        ).bind(a.mailboxId, id, a.role, t),
      ),
    );
  }
  const inviteUrl = await issueToken(c.env, id, "invite", actor.id, 24 * 7);
  const emailed = body.sendEmail ? await emailInvite(c.env, body.email, inviteUrl, actor.name || actor.email, body.name) : false;
  await audit(c, { action: "user.invited", targetType: "user", targetId: id, meta: { email: body.email, role: body.role, mailboxId, access: body.access } });
  return c.json({ id, inviteUrl, emailed }, 201);
});

async function loadTarget(db: D1Database, actor: SessionUser, id: string): Promise<UserRow> {
  const u = await getUser(db, id);
  if (!u) throw new HTTPException(404, { message: "User not found" });
  if (u.role === "owner" && actor.role !== "owner") throw new HTTPException(403, { message: "Only owners can manage owners." });
  return u;
}

async function activeOwnerCount(db: D1Database): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND status = 'active'").first<{ n: number }>();
  return r?.n ?? 0;
}

adminUserRoutes.patch("/:id", async (c) => {
  const body = await parseBody(
    c,
    z.object({
      name: z.string().trim().max(120).optional(),
      role: z.enum(["owner", "admin", "manager", "member"]).optional(),
      status: z.enum(["active", "disabled"]).optional(),
      unlock: z.boolean().optional(),
    }),
  );
  const actor = c.get("user");
  const target = await loadTarget(c.env.DB, actor, c.req.param("id"));
  if (body.role === "owner" && actor.role !== "owner") throw new HTTPException(403, { message: "Only owners can grant owner." });
  if (target.id === actor.id && (body.role && body.role !== target.role || body.status === "disabled")) {
    throw new HTTPException(400, { message: "You can't change your own role or disable yourself." });
  }
  const losingOwner = target.role === "owner" && target.status === "active" && ((body.role && body.role !== "owner") || body.status === "disabled");
  if (losingOwner && (await activeOwnerCount(c.env.DB)) <= 1) {
    throw new HTTPException(400, { message: "There must always be at least one active owner." });
  }
  // Invited users stay invited until they accept, unless being disabled.
  const status: UserStatus = body.status === "disabled" ? "disabled" : body.status === "active" && target.status === "disabled" ? (target.password_hash || target.google_sub ? "active" : "invited") : target.status;
  const role: Role = body.role ?? target.role;
  const stored = storedRole(role);
  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `UPDATE users SET name = ?, role = ?, is_manager = ?, status = ?, updated_at = ?,
         failed_logins = CASE WHEN ? THEN 0 ELSE failed_logins END, locked_until = CASE WHEN ? THEN NULL ELSE locked_until END
       WHERE id = ?`,
    ).bind(body.name ?? target.name, stored.role, stored.isManager, status, now(), body.unlock ? 1 : 0, body.unlock ? 1 : 0, target.id),
  ];
  if (status === "disabled") stmts.push(...offboardStatements(c.env.DB, target.id));
  await c.env.DB.batch(stmts);
  await audit(c, {
    action: "user.updated",
    targetType: "user",
    targetId: target.id,
    meta: { email: target.email, from: { role: target.role, status: target.status }, to: { role, status }, unlock: !!body.unlock },
  });
  return c.json({ ok: true });
});

/** Stop someone's unread-mail reminders to their personal address (e.g. offboarding). */
adminUserRoutes.post("/:id/digest-off", async (c) => {
  const target = await loadTarget(c.env.DB, c.get("user"), c.req.param("id"));
  await c.env.DB.prepare("UPDATE users SET digest_enabled = 0, digest_next_at = NULL WHERE id = ?").bind(target.id).run();
  await audit(c, { action: "user.digest_disabled", targetType: "user", targetId: target.id, meta: { via: "admin" } });
  return c.json({ ok: true });
});

adminUserRoutes.post("/:id/invite", async (c) => {
  const actor = c.get("user");
  const target = await loadTarget(c.env.DB, actor, c.req.param("id"));
  if (target.status !== "invited") throw new HTTPException(400, { message: "This user has already joined." });
  const inviteUrl = await issueToken(c.env, target.id, "invite", actor.id, 24 * 7);
  const { sendEmail } = await parseBody(c, z.object({ sendEmail: z.boolean().default(true) }));
  const emailed = sendEmail ? await emailInvite(c.env, target.email, inviteUrl, actor.name || actor.email, target.name) : false;
  await audit(c, { action: "user.invite_reissued", targetType: "user", targetId: target.id });
  return c.json({ inviteUrl, emailed });
});

adminUserRoutes.post("/:id/reset-password", async (c) => {
  const actor = c.get("user");
  const target = await loadTarget(c.env.DB, actor, c.req.param("id"));
  if (target.status !== "active") throw new HTTPException(400, { message: "User is not active." });
  const resetUrl = await issueToken(c.env, target.id, "reset", actor.id, 24);
  const brand = await getBrand(c.env.DB);
  const emailed = await sendSystemEmail(
    c.env,
    target.email,
    templates.reset(brand, { name: target.name, url: resetUrl, expires: "24 hours", byAdmin: actor.name || actor.email }),
    "password_reset",
  );
  await audit(c, { action: "user.password_reset_issued", targetType: "user", targetId: target.id });
  return c.json({ resetUrl, emailed });
});

adminUserRoutes.post("/:id/reset-2fa", async (c) => {
  const target = await loadTarget(c.env.DB, c.get("user"), c.req.param("id"));
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET totp_enabled = 0, totp_secret = NULL, recovery_codes = NULL, updated_at = ? WHERE id = ?").bind(now(), target.id),
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(target.id),
  ]);
  await audit(c, { action: "user.2fa_reset", targetType: "user", targetId: target.id, meta: { email: target.email } });
  return c.json({ ok: true });
});

/** Lost or stolen device: remove every passkey and end their sessions (the device may still be signed in). */
adminUserRoutes.post("/:id/remove-passkeys", async (c) => {
  const target = await loadTarget(c.env.DB, c.get("user"), c.req.param("id"));
  const [removed] = await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM passkeys WHERE user_id = ?").bind(target.id),
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(target.id),
  ]);
  await audit(c, { action: "user.passkeys_removed", targetType: "user", targetId: target.id, meta: { email: target.email, count: removed.meta.changes } });
  return c.json({ ok: true, removed: removed.meta.changes });
});

adminUserRoutes.post("/:id/sign-out", async (c) => {
  const target = await loadTarget(c.env.DB, c.get("user"), c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(target.id).run();
  await audit(c, { action: "user.signed_out_everywhere", targetType: "user", targetId: target.id });
  return c.json({ ok: true });
});

adminUserRoutes.delete("/:id", async (c) => {
  const actor = c.get("user");
  const target = await loadTarget(c.env.DB, actor, c.req.param("id"));
  if (target.id === actor.id) throw new HTTPException(400, { message: "You can't delete yourself." });
  if (target.role === "owner" && target.status === "active" && (await activeOwnerCount(c.env.DB)) <= 1) {
    throw new HTTPException(400, { message: "There must always be at least one active owner." });
  }
  // Deleting the user drops their memberships, which is what a user hold covers.
  if (await isUserHeld(c.env.DB, target.id)) {
    throw new HTTPException(409, { message: "This person is under legal hold and can't be deleted. Disable them instead, or release the hold first." });
  }
  await c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(target.id).run();
  await audit(c, { action: "user.deleted", targetType: "user", targetId: target.id, meta: { email: target.email } });
  return c.json({ ok: true });
});
