import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { BULK_CHUNK, BULK_MAX, BULK_PURGE_BUDGET, countResults, MAILBOX_BULK_ACTIONS, type BulkResult, type BulkRowResult } from "@shared/admin";
import type { MailboxRole } from "@shared/types";
import type { AppEnv } from "../env";
import { auditMany, type AuditEntry } from "../lib/audit";
import { heldMailboxIds, snapshotMembershipStatement } from "../lib/legal-hold";
import { deleteMailboxStep, mailboxBulkParamsProblem, mailboxListSql, parseMailboxFilter, planMailboxBulk, type MailboxTarget } from "../lib/mailbox-admin";
import { now } from "../lib/util";
import { parseBody, zId } from "../lib/validate";
import { emitFromRequest, type QueuedEvent } from "../lib/webhooks";

/** POST /api/admin/mailboxes/bulk: one action for many mailboxes, with a dry run that explains each row. */
export const adminMailboxBulkRoutes = new Hono<AppEnv>();

const zBulk = z
  .object({
    ids: z.array(zId).max(BULK_MAX).optional(),
    filter: z.record(z.string(), z.unknown()).optional(),
    action: z.enum(MAILBOX_BULK_ACTIONS),
    params: z
      .object({
        userId: zId.optional(),
        access: z.enum(["owner", "editor", "viewer"]).optional(),
        type: z.enum(["personal", "shared"]).optional(),
        confirm: z.string().max(20).optional(),
      })
      .default({}),
    dryRun: z.boolean().default(false),
  })
  .refine((b) => (b.ids && b.ids.length > 0) || b.filter, { message: "Choose some mailboxes first." });

const ACTION_AUDIT: Record<(typeof MAILBOX_BULK_ACTIONS)[number], string> = {
  add_member: "mailbox.member_set",
  remove_member: "mailbox.member_removed",
  set_type: "mailbox.updated",
  activate: "mailbox.updated",
  deactivate: "mailbox.updated",
  delete: "mailbox.deleted",
};

adminMailboxBulkRoutes.post("/bulk", async (c) => {
  const body = await parseBody(c, zBulk);
  const db = c.env.DB;
  const problem = mailboxBulkParamsProblem(body.action, body.params);
  if (problem) throw new HTTPException(400, { message: problem });
  if (body.action === "delete" && !body.dryRun && body.params.confirm?.toLowerCase() !== "delete") {
    throw new HTTPException(400, { message: 'Type "delete" to confirm.' });
  }

  type Row = { id: string; address: string; type: "personal" | "shared"; is_active: number };
  let rows: Row[];
  if (body.ids?.length) {
    const { results } = await db
      .prepare("SELECT id, address, type, is_active FROM mailboxes WHERE is_system = 0 AND id IN (SELECT value FROM json_each(?)) ORDER BY address")
      .bind(JSON.stringify([...new Set(body.ids)]))
      .all<Row>();
    rows = results;
  } else {
    const { where, binds, order } = mailboxListSql(parseMailboxFilter(body.filter ?? {}));
    const { results } = await db
      .prepare(`SELECT m.id, m.address, m.type, m.is_active, 0 AS member_count FROM mailboxes m ${where} ORDER BY ${order} LIMIT ?`)
      .bind(...binds, BULK_MAX + 1)
      .all<Row>();
    if (results.length > BULK_MAX) throw new HTTPException(400, { message: `That filter matches more than ${BULK_MAX.toLocaleString()} mailboxes. Narrow it down and try again.` });
    rows = results;
  }
  if (!body.dryRun && rows.length > BULK_CHUNK) {
    throw new HTTPException(400, { message: `Send at most ${BULK_CHUNK} mailboxes per request; the console splits bigger selections automatically.` });
  }

  let person: { id: string; email: string } | null = null;
  const membership = new Map<string, MailboxRole>();
  if (body.action === "add_member" || body.action === "remove_member") {
    person = await db.prepare("SELECT id, email FROM users WHERE id = ?").bind(body.params.userId).first<{ id: string; email: string }>();
    if (!person) throw new HTTPException(404, { message: "User not found" });
    const { results } = await db.prepare("SELECT mailbox_id, role FROM mailbox_members WHERE user_id = ?").bind(person.id).all<{ mailbox_id: string; role: MailboxRole }>();
    for (const m of results) membership.set(m.mailbox_id, m.role);
  }
  const held = body.action === "delete" ? await heldMailboxIds(db) : new Set<string>();
  const targets: MailboxTarget[] = rows.map((r) => ({ id: r.id, address: r.address, type: r.type, isActive: !!r.is_active }));
  const plan = planMailboxBulk(targets, body.action, body.params, { membership, held });
  const missing = body.ids?.filter((id) => !rows.some((r) => r.id === id)) ?? [];
  const results: BulkRowResult[] = [
    ...plan.map((p) => ({ id: p.target.id, label: p.target.address, status: p.status, message: p.message })),
    ...missing.map((id) => ({ id, label: id, status: "skipped" as const, message: "No longer exists." })),
  ];
  if (body.dryRun) return c.json({ action: body.action, dryRun: true, results, counts: countResults(results) } satisfies BulkResult);

  const doing = plan.filter((p) => p.status === "ok").map((p) => p.target);
  const t = now();
  if (body.action === "delete") {
    // Deleting purges mail, which is slow: spend a fixed budget per request and report the rest as remaining.
    let budget = BULK_PURGE_BUDGET;
    for (const m of doing) {
      const r = results.find((x) => x.id === m.id)!;
      if (budget <= 0) {
        Object.assign(r, { status: "remaining", message: "Still deleting…" });
        continue;
      }
      try {
        const step = await deleteMailboxStep(c.env, m.id, c.get("user").id, budget);
        budget -= step.purged;
        if (!step.done) Object.assign(r, { status: "remaining", message: "Still deleting…" });
      } catch (err) {
        console.error("bulk mailbox delete failed", m.id, err);
        Object.assign(r, { status: "failed", message: "Couldn't delete it. Try again." });
      }
    }
  } else if (doing.length) {
    const stmts: D1PreparedStatement[] = doing.flatMap((m) => {
      switch (body.action) {
        case "add_member":
          return [
            db
              .prepare(
                `INSERT INTO mailbox_members (mailbox_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT(mailbox_id, user_id) DO UPDATE SET role = excluded.role`,
              )
              .bind(m.id, person!.id, body.params.access!, t),
          ];
        case "remove_member":
          return [snapshotMembershipStatement(db, person!.id, m.id), db.prepare("DELETE FROM mailbox_members WHERE mailbox_id = ? AND user_id = ?").bind(m.id, person!.id)];
        case "set_type":
          return [db.prepare("UPDATE mailboxes SET type = ?, updated_at = ? WHERE id = ?").bind(body.params.type!, t, m.id)];
        default:
          return [db.prepare("UPDATE mailboxes SET is_active = ?, updated_at = ? WHERE id = ?").bind(body.action === "activate" ? 1 : 0, t, m.id)];
      }
    });
    try {
      // One transaction for the whole chunk.
      await db.batch(stmts);
    } catch (err) {
      console.error("bulk mailbox action failed", body.action, err);
      for (const r of results) if (r.status === "ok") Object.assign(r, { status: "failed", message: "Couldn't save this change. Nothing in this batch was changed; try again." });
    }
  }

  const applied = results.filter((r) => r.status === "ok");
  const byId = new Map(doing.map((m) => [m.id, m]));
  const entries: AuditEntry[] = applied.map((r) => ({
    action: ACTION_AUDIT[body.action],
    targetType: "mailbox",
    targetId: r.id,
    meta: {
      via: "bulk",
      bulkAction: body.action,
      address: byId.get(r.id)?.address,
      ...(person ? { userId: person.id, role: body.params.access } : {}),
      ...(body.action === "set_type" ? { type: body.params.type } : {}),
      ...(body.action === "activate" || body.action === "deactivate" ? { isActive: body.action === "activate" } : {}),
    },
  }));
  entries.push({ action: "mailbox.bulk", targetType: "mailbox", meta: { action: body.action, params: { ...body.params, confirm: undefined }, counts: countResults(results) } });
  await auditMany(c, entries);
  if (body.action === "delete") {
    const events: QueuedEvent[] = applied.map((r) => ({ type: "mailbox.deleted", data: { id: r.id, address: byId.get(r.id)!.address, via: "bulk" } }));
    emitFromRequest(c, events);
  }
  return c.json({ action: body.action, dryRun: false, results, counts: countResults(results) } satisfies BulkResult);
});
