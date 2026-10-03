import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireFeature } from "../lib/features";
import { audit } from "../lib/audit";
import { heldMailboxIds } from "../lib/legal-hold";
import { previewRetention, type RetentionScope } from "../lib/retention";
import { getPolicy, saveSetting } from "../lib/settings";
import { clampInt, newId, now } from "../lib/util";
import { parseBody, zId } from "../lib/validate";

/**
 * Admin → Compliance: retention policies and legal holds. Everyone in the
 * console can look; only owners can change anything, because both decide
 * whether mail is destroyed.
 */
export const adminComplianceRoutes = new Hono<AppEnv>();
adminComplianceRoutes.use("*", requireFeature("compliance"));

export const requireOwner: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("user").role !== "owner") throw new HTTPException(403, { message: "Only owners can do this." });
  await next();
};

const zScope = z.enum(["all", "archive"]);
const MAX_DAYS = 36_500;

// ---- Retention ------------------------------------------------------------

adminComplianceRoutes.get("/retention", async (c) => {
  const [policy, held, { results }] = await Promise.all([
    getPolicy(c.env.DB),
    heldMailboxIds(c.env.DB),
    c.env.DB.prepare(
      "SELECT id, address, COALESCE(NULLIF(name, ''), display_name) AS name, retention_days, retention_scope FROM mailboxes WHERE is_system = 0 ORDER BY address",
    ).all<{ id: string; address: string; name: string; retention_days: number | null; retention_scope: RetentionScope | null }>(),
  ]);
  return c.json({
    org: { retentionDays: policy.retentionDays, retentionScope: policy.retentionScope },
    mailboxes: results.map((r) => ({
      id: r.id,
      address: r.address,
      name: r.name,
      retentionDays: r.retention_days,
      retentionScope: r.retention_days === null ? null : (r.retention_scope ?? "all"),
      held: held.has(r.id),
    })),
  });
});

adminComplianceRoutes.put("/retention", requireOwner, async (c) => {
  const body = await parseBody(c, z.object({ retentionDays: z.number().int().min(0).max(MAX_DAYS), retentionScope: zScope }));
  const policy = await getPolicy(c.env.DB);
  await saveSetting(c.env.DB, "policy", { ...policy, ...body }, c.get("user").id);
  await audit(c, {
    action: "retention.policy_updated",
    targetType: "settings",
    meta: { from: { days: policy.retentionDays, scope: policy.retentionScope }, to: { days: body.retentionDays, scope: body.retentionScope } },
  });
  return c.json({ ok: true });
});

adminComplianceRoutes.put("/retention/mailboxes/:id", requireOwner, async (c) => {
  const id = c.req.param("id");
  const body = await parseBody(c, z.object({ retentionDays: z.number().int().min(0).max(MAX_DAYS).nullable(), retentionScope: zScope.nullable().optional() }));
  const before = await c.env.DB.prepare("SELECT address, retention_days, retention_scope FROM mailboxes WHERE id = ? AND is_system = 0")
    .bind(id)
    .first<{ address: string; retention_days: number | null; retention_scope: string | null }>();
  if (!before) throw new HTTPException(404, { message: "Mailbox not found" });
  const scope = body.retentionDays === null ? null : (body.retentionScope ?? "all");
  await c.env.DB.prepare("UPDATE mailboxes SET retention_days = ?, retention_scope = ?, updated_at = ? WHERE id = ?")
    .bind(body.retentionDays, scope, now(), id)
    .run();
  await audit(c, {
    action: "retention.mailbox_updated",
    targetType: "mailbox",
    targetId: id,
    meta: { address: before.address, from: { days: before.retention_days, scope: before.retention_scope }, to: { days: body.retentionDays, scope } },
  });
  return c.json({ ok: true });
});

/**
 * How many messages a setting would delete right now.
 * ?days=&scope=           an org-wide setting (mailbox overrides still apply)
 * ?mailboxId=&days=&scope= one mailbox's override (days empty = follow the org)
 */
adminComplianceRoutes.get("/retention/preview", async (c) => {
  const policy = await getPolicy(c.env.DB);
  const scope = zScope.catch("all").parse(c.req.query("scope"));
  const rawDays = c.req.query("days") ?? "";
  const days = rawDays === "" ? null : clampInt(rawDays, 0, MAX_DAYS, 0);
  const held = await heldMailboxIds(c.env.DB);
  const mailboxId = c.req.query("mailboxId");
  const result = mailboxId
    ? await previewRetention(c.env.DB, held, { org: policy, mailboxId, override: { retention_days: days, retention_scope: scope } })
    : await previewRetention(c.env.DB, held, { org: { retentionDays: days ?? 0, retentionScope: scope } });
  return c.json(result);
});

// ---- Legal holds ----------------------------------------------------------

interface HoldRow {
  id: string;
  name: string;
  reason: string;
  mailbox_id: string | null;
  user_id: string | null;
  target_label: string;
  created_by_email: string | null;
  created_at: string;
  released_at: string | null;
  released_by_email: string | null;
}

adminComplianceRoutes.get("/holds", async (c) => {
  const limit = clampInt(c.req.query("limit"), 1, 500, 200);
  const [{ results }, held] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM legal_holds ORDER BY released_at IS NOT NULL, created_at DESC LIMIT ?").bind(limit).all<HoldRow>(),
    heldMailboxIds(c.env.DB),
  ]);
  return c.json({
    heldMailboxes: held.size,
    items: results.map((h) => ({
      id: h.id,
      name: h.name,
      reason: h.reason,
      target: h.mailbox_id ? { type: "mailbox", id: h.mailbox_id, label: h.target_label } : { type: "user", id: h.user_id, label: h.target_label },
      createdBy: h.created_by_email,
      createdAt: h.created_at,
      releasedAt: h.released_at,
      releasedBy: h.released_by_email,
    })),
  });
});

adminComplianceRoutes.post("/holds", requireOwner, async (c) => {
  const body = await parseBody(
    c,
    z
      .object({
        name: z.string().trim().min(1, "Give the hold a name").max(120),
        reason: z.string().trim().max(2000).default(""),
        mailboxId: zId.optional(),
        userId: zId.optional(),
      })
      .refine((b) => !!b.mailboxId !== !!b.userId, "Choose either a mailbox or a person"),
  );
  const u = c.get("user");
  const db = c.env.DB;
  let label: string;
  if (body.mailboxId) {
    const mb = await db.prepare("SELECT address FROM mailboxes WHERE id = ?").bind(body.mailboxId).first<{ address: string }>();
    if (!mb) throw new HTTPException(404, { message: "Mailbox not found" });
    label = mb.address;
  } else {
    const target = await db.prepare("SELECT email FROM users WHERE id = ?").bind(body.userId).first<{ email: string }>();
    if (!target) throw new HTTPException(404, { message: "User not found" });
    label = target.email;
  }
  const id = newId();
  const stmts = [
    db
      .prepare(
        `INSERT INTO legal_holds (id, name, reason, mailbox_id, user_id, target_label, created_by, created_by_email, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, body.name, body.reason, body.mailboxId ?? null, body.userId ?? null, label, u.id, u.email, now()),
  ];
  // Remember the person's current mailboxes; later memberships are covered live.
  if (body.userId) {
    stmts.push(
      db
        .prepare("INSERT OR IGNORE INTO legal_hold_mailboxes (hold_id, mailbox_id) SELECT ?, mailbox_id FROM mailbox_members WHERE user_id = ?")
        .bind(id, body.userId),
    );
  }
  await db.batch(stmts);
  await audit(c, {
    action: "legal_hold.placed",
    targetType: body.mailboxId ? "mailbox" : "user",
    targetId: body.mailboxId ?? body.userId ?? null,
    meta: { holdId: id, name: body.name, reason: body.reason, target: label },
  });
  return c.json({ id }, 201);
});

adminComplianceRoutes.post("/holds/:id/release", requireOwner, async (c) => {
  const id = c.req.param("id");
  const u = c.get("user");
  const hold = await c.env.DB.prepare("SELECT * FROM legal_holds WHERE id = ?").bind(id).first<HoldRow>();
  if (!hold) throw new HTTPException(404, { message: "Hold not found" });
  if (hold.released_at) throw new HTTPException(409, { message: "This hold was already released." });
  await c.env.DB.prepare("UPDATE legal_holds SET released_at = ?, released_by_email = ? WHERE id = ? AND released_at IS NULL").bind(now(), u.email, id).run();
  await audit(c, {
    action: "legal_hold.released",
    targetType: hold.mailbox_id ? "mailbox" : "user",
    targetId: hold.mailbox_id ?? hold.user_id,
    meta: { holdId: id, name: hold.name, target: hold.target_label },
  });
  return c.json({ ok: true });
});
