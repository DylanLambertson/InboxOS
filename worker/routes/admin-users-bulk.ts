import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { BULK_CHUNK, BULK_EMAIL_CHUNK, BULK_MAX, countResults, USER_BULK_ACTIONS, type BulkResult, type BulkRowResult } from "@shared/admin";
import type { MailboxRole } from "@shared/types";
import type { AppEnv } from "../env";
import { auditMany, type AuditEntry } from "../lib/audit";
import { snapshotMembershipStatement } from "../lib/legal-hold";
import { storedRole } from "../lib/roles";
import { parseUserFilter, userListSql } from "../lib/user-admin";
import { bulkParamsProblem, planUserBulk, type BulkTarget, type PlannedRow } from "../lib/user-bulk";
import { offboardStatements, withRole } from "../lib/users";
import { now } from "../lib/util";
import { parseBody, zId } from "../lib/validate";
import { emitFromRequest, type QueuedEvent } from "../lib/webhooks";
import { activeOwnerCount, emailInvite, issueToken, reset2faStatements } from "./admin-users";

/** POST /api/admin/users/bulk: one action for many people, with a dry run that explains each row. */
export const adminUserBulkRoutes = new Hono<AppEnv>();

const zBulk = z
  .object({
    ids: z.array(zId).max(BULK_MAX).optional(),
    filter: z.record(z.string(), z.unknown()).optional(),
    action: z.enum(USER_BULK_ACTIONS),
    params: z
      .object({
        role: z.enum(["owner", "admin", "manager", "member"]).optional(),
        mailboxId: zId.optional(),
        access: z.enum(["owner", "editor", "viewer"]).optional(),
      })
      .default({}),
    dryRun: z.boolean().default(false),
  })
  .refine((b) => (b.ids && b.ids.length > 0) || b.filter, { message: "Choose some people first." });

interface TargetRow {
  id: string;
  email: string;
  name: string;
  role: string;
  is_manager: number;
  status: BulkTarget["status"];
  totp_enabled: number;
  password_hash: string | null;
  google_sub: string | null;
}

const ACTION_AUDIT: Record<(typeof USER_BULK_ACTIONS)[number], string> = {
  role: "user.updated",
  disable: "user.updated",
  enable: "user.updated",
  resend_invite: "user.invite_reissued",
  reset_2fa: "user.2fa_reset",
  sign_out: "user.signed_out_everywhere",
  add_mailbox: "mailbox.member_set",
  remove_mailbox: "mailbox.member_removed",
  delete: "user.deleted",
};

adminUserBulkRoutes.post("/bulk", async (c) => {
  const body = await parseBody(c, zBulk);
  const db = c.env.DB;
  const actor = c.get("user");
  const paramProblem = bulkParamsProblem(body.action, body.params);
  if (paramProblem) throw new HTTPException(400, { message: paramProblem });

  // Who: explicit ids, or everyone matching the Users filter (up to the cap).
  let rows: TargetRow[];
  const cols = "u.id, u.email, u.name, u.role, u.is_manager, u.status, u.totp_enabled, u.password_hash, u.google_sub";
  if (body.ids?.length) {
    const ids = [...new Set(body.ids)];
    const { results } = await db.prepare(`SELECT ${cols} FROM users u WHERE u.id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)).all<TargetRow>();
    rows = results;
  } else {
    const { where, binds, order } = userListSql(parseUserFilter(body.filter ?? {}));
    const { results } = await db.prepare(`SELECT ${cols}, 0 AS mailbox_count FROM users u ${where} ORDER BY ${order} LIMIT ?`).bind(...binds, BULK_MAX + 1).all<TargetRow>();
    if (results.length > BULK_MAX) throw new HTTPException(400, { message: `That filter matches more than ${BULK_MAX.toLocaleString()} people. Narrow it down and try again.` });
    rows = results;
  }
  const chunk = body.action === "resend_invite" ? BULK_EMAIL_CHUNK : BULK_CHUNK;
  if (!body.dryRun && rows.length > chunk) {
    throw new HTTPException(400, { message: `Send at most ${chunk} people per request; the console splits bigger selections automatically.` });
  }

  let mailbox: { id: string; address: string } | null = null;
  const membership = new Map<string, MailboxRole>();
  if (body.action === "add_mailbox" || body.action === "remove_mailbox") {
    mailbox = await db.prepare("SELECT id, address FROM mailboxes WHERE id = ? AND is_system = 0").bind(body.params.mailboxId).first<{ id: string; address: string }>();
    if (!mailbox) throw new HTTPException(404, { message: "Mailbox not found" });
    const { results } = await db.prepare("SELECT user_id, role FROM mailbox_members WHERE mailbox_id = ?").bind(mailbox.id).all<{ user_id: string; role: MailboxRole }>();
    for (const m of results) membership.set(m.user_id, m.role);
  }
  const held = new Set<string>();
  if (body.action === "delete") {
    const { results } = await db.prepare("SELECT user_id FROM legal_holds WHERE released_at IS NULL AND user_id IS NOT NULL").all<{ user_id: string }>();
    for (const h of results) held.add(h.user_id);
  }

  const targets: BulkTarget[] = rows.map((r) => {
    const u = withRole(r)!;
    return { id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, totpEnabled: !!u.totp_enabled };
  });
  const plan = planUserBulk(actor, targets, body.action, body.params, { activeOwners: await activeOwnerCount(db), heldUserIds: held, membership });
  const missing = body.ids?.filter((id) => !rows.some((r) => r.id === id)) ?? [];
  const toResult = (p: PlannedRow): BulkRowResult => ({ id: p.target.id, label: p.target.name ? `${p.target.name} (${p.target.email})` : p.target.email, status: p.status, message: p.message });
  const results: BulkRowResult[] = [...plan.map(toResult), ...missing.map((id) => ({ id, label: id, status: "skipped" as const, message: "No longer exists." }))];
  if (body.dryRun) return c.json({ action: body.action, dryRun: true, results, counts: countResults(results) } satisfies BulkResult);

  const doing = plan.filter((p) => p.status === "ok");
  const raw = new Map(rows.map((r) => [r.id, r]));
  const t = now();
  const stmts: D1PreparedStatement[] = [];
  for (const { target } of doing) {
    switch (body.action) {
      case "role": {
        const s = storedRole(body.params.role!);
        stmts.push(db.prepare("UPDATE users SET role = ?, is_manager = ?, updated_at = ? WHERE id = ?").bind(s.role, s.isManager, t, target.id));
        break;
      }
      case "disable":
        stmts.push(db.prepare("UPDATE users SET status = 'disabled', updated_at = ? WHERE id = ?").bind(t, target.id), ...offboardStatements(db, target.id));
        break;
      case "enable": {
        const r = raw.get(target.id)!;
        stmts.push(db.prepare("UPDATE users SET status = ?, updated_at = ? WHERE id = ?").bind(r.password_hash || r.google_sub ? "active" : "invited", t, target.id));
        break;
      }
      case "reset_2fa":
        stmts.push(...reset2faStatements(db, target.id));
        break;
      case "sign_out":
        stmts.push(db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(target.id));
        break;
      case "add_mailbox":
        stmts.push(
          db
            .prepare(
              `INSERT INTO mailbox_members (mailbox_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
               ON CONFLICT(mailbox_id, user_id) DO UPDATE SET role = excluded.role`,
            )
            .bind(mailbox!.id, target.id, body.params.access!, t),
        );
        break;
      case "remove_mailbox":
        stmts.push(snapshotMembershipStatement(db, target.id, mailbox!.id), db.prepare("DELETE FROM mailbox_members WHERE mailbox_id = ? AND user_id = ?").bind(mailbox!.id, target.id));
        break;
      case "delete":
        stmts.push(db.prepare("DELETE FROM users WHERE id = ?").bind(target.id));
        break;
      case "resend_invite":
        break;
    }
  }

  // All database changes for this chunk in one transaction: they all apply, or none do.
  if (stmts.length) {
    try {
      await db.batch(stmts);
    } catch (err) {
      console.error("bulk user action failed", body.action, err);
      for (const r of results) if (r.status === "ok") Object.assign(r, { status: "failed", message: "Couldn't save this change. Nothing in this batch was changed; try again." });
      return c.json({ action: body.action, dryRun: false, results, counts: countResults(results) } satisfies BulkResult);
    }
  }
  // Invites send email one by one; a failure only affects that row.
  if (body.action === "resend_invite") {
    for (const r of results.filter((x) => x.status === "ok")) {
      const target = doing.find((d) => d.target.id === r.id)!.target;
      try {
        const url = await issueToken(c.env, target.id, "invite", actor.id, 24 * 7);
        const emailed = await emailInvite(c.env, target.email, url, actor.name || actor.email, target.name);
        if (!emailed) Object.assign(r, { message: "New link created, but email isn't available. Copy it from their row." });
      } catch (err) {
        console.error("bulk invite failed", target.id, err);
        Object.assign(r, { status: "failed", message: "Couldn't create the invite. Try again." });
      }
    }
  }

  const applied = results.filter((r) => r.status === "ok");
  const entries: AuditEntry[] = applied.map((r) => {
    const target = doing.find((d) => d.target.id === r.id)!.target;
    const mailboxAction = body.action === "add_mailbox" || body.action === "remove_mailbox";
    return {
      action: ACTION_AUDIT[body.action],
      targetType: mailboxAction ? "mailbox" : "user",
      targetId: mailboxAction ? mailbox!.id : target.id,
      meta: { via: "bulk", bulkAction: body.action, email: target.email, ...(mailboxAction ? { userId: target.id, role: body.params.access } : {}), ...(body.params.role ? { from: { role: target.role }, to: { role: body.params.role } } : {}) },
    };
  });
  entries.push({ action: "user.bulk", targetType: "user", meta: { action: body.action, params: body.params, counts: countResults(results) } });
  await auditMany(c, entries);

  const events: QueuedEvent[] = [];
  for (const r of applied) {
    const target = doing.find((d) => d.target.id === r.id)!.target;
    if (body.action === "disable") events.push({ type: "user.disabled", data: { id: target.id, email: target.email, name: target.name, role: target.role, status: "disabled", via: "bulk" } });
    if (body.action === "delete") events.push({ type: "user.deleted", data: { id: target.id, email: target.email, name: target.name, via: "bulk" } });
  }
  emitFromRequest(c, events);
  return c.json({ action: body.action, dryRun: false, results, counts: countResults(results) } satisfies BulkResult);
});
