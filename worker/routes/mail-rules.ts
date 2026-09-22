import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  MAX_ACTIONS_PER_RULE,
  MAX_CONDITIONS_PER_RULE,
  MAX_RULES_PER_MAILBOX,
  RULE_FIELDS,
  RULE_FOLDERS,
  RULE_OPERATORS,
  TEXT_FIELDS,
  type MailRule,
  type MailRuleInput,
} from "@shared/mail-rules";
import type { AppEnv } from "../env";
import { requireMailbox } from "../lib/access";
import { audit } from "../lib/audit";
import { loadRules, runRuleOnExisting, testRule, toRule, type RuleRow } from "../lib/rules";
import { newId, now } from "../lib/util";
import { parseBody, zId } from "../lib/validate";

/** Mail rules (filters) per mailbox: /api/mailboxes/:id/rules. Viewers read, editors write. */
export const mailRuleRoutes = new Hono<AppEnv>();

const zCondition = z
  .object({
    field: z.enum(RULE_FIELDS),
    op: z.enum(RULE_OPERATORS).optional(),
    value: z.string().trim().max(300),
    header: z
      .string()
      .trim()
      .max(100)
      .regex(/^[A-Za-z0-9-]*$/, "Header names use letters, digits and dashes")
      .optional(),
  })
  .superRefine((c, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: "custom", message });
    if (TEXT_FIELDS.includes(c.field)) {
      if (!c.op) bad("Pick how to compare");
      if (!c.value) bad("Enter text to look for");
      if (c.field === "header" && !c.header) bad("Enter a header name");
    } else if (c.field === "has_attachment" && !["yes", "no"].includes(c.value)) bad("Choose yes or no");
    else if (c.field === "size_gt" && !(/^\d{1,7}$/.test(c.value) && Number(c.value) > 0)) bad("Enter a size in KB");
    else if (c.field === "sender_contact" && !["in", "not_in"].includes(c.value)) bad("Choose in or not in contacts");
  });

const zAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("label"), labelId: zId }),
  z.object({ type: z.literal("move"), folder: z.enum(RULE_FOLDERS) }),
  z.object({ type: z.literal("read") }),
  z.object({ type: z.literal("star") }),
  z.object({ type: z.literal("important") }),
]);

const zRuleFields = z.object({
  name: z.string().trim().min(1, "Name the rule").max(100),
  enabled: z.boolean().default(true),
  match: z.enum(["all", "any"]).default("all"),
  conditions: z.array(zCondition).min(1, "Add at least one condition").max(MAX_CONDITIONS_PER_RULE),
  actions: z.array(zAction).max(MAX_ACTIONS_PER_RULE).default([]),
  stopProcessing: z.boolean().default(false),
});
const zRule = zRuleFields.refine((r) => r.actions.length > 0 || r.stopProcessing, { message: "Add at least one action", path: ["actions"] });

/** Rule actions may only reference this mailbox's labels; keep one copy of each action. */
async function cleanRule(db: D1Database, mailboxId: string, rule: MailRuleInput): Promise<MailRuleInput> {
  const labelIds = [...new Set(rule.actions.flatMap((a) => (a.type === "label" ? [a.labelId] : [])))];
  if (labelIds.length) {
    const { results } = await db
      .prepare(`SELECT id FROM labels WHERE mailbox_id = ? AND id IN (${labelIds.map(() => "?").join(",")})`)
      .bind(mailboxId, ...labelIds)
      .all<{ id: string }>();
    if (results.length !== labelIds.length) throw new HTTPException(400, { message: "That label no longer exists in this mailbox." });
  }
  const seen = new Set<string>();
  const actions = rule.actions.filter((a) => {
    // At most one move: a message lives in one folder.
    const key = a.type === "label" ? `label:${a.labelId}` : a.type;
    return !seen.has(key) && !!seen.add(key);
  });
  const conditions = rule.conditions.map((c) =>
    TEXT_FIELDS.includes(c.field) ? { field: c.field, op: c.op, value: c.value, ...(c.field === "header" ? { header: c.header } : {}) } : { field: c.field, value: c.value },
  );
  return { ...rule, conditions, actions };
}

async function requireRule(db: D1Database, mailboxId: string, ruleId: string): Promise<MailRule> {
  const row = await db.prepare("SELECT * FROM mail_rules WHERE id = ? AND mailbox_id = ?").bind(ruleId, mailboxId).first<RuleRow>();
  if (!row) throw new HTTPException(404, { message: "Rule not found" });
  return toRule(row);
}

mailRuleRoutes.get("/:id/rules", async (c) => {
  const id = c.req.param("id");
  await requireMailbox(c.env.DB, c.get("user"), id);
  return c.json(await loadRules(c.env.DB, id));
});

mailRuleRoutes.post("/:id/rules", async (c) => {
  const id = c.req.param("id");
  const u = c.get("user");
  await requireMailbox(c.env.DB, u, id, "editor");
  const rule = await cleanRule(c.env.DB, id, await parseBody(c, zRule));
  const stats = await c.env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(position), -1) AS last FROM mail_rules WHERE mailbox_id = ?")
    .bind(id)
    .first<{ n: number; last: number }>();
  if ((stats?.n ?? 0) >= MAX_RULES_PER_MAILBOX) throw new HTTPException(400, { message: `A mailbox can have up to ${MAX_RULES_PER_MAILBOX} rules.` });
  const ruleId = newId();
  const t = now();
  await c.env.DB.prepare(
    `INSERT INTO mail_rules (id, mailbox_id, name, enabled, position, match, conditions, actions, stop_processing, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(ruleId, id, rule.name, rule.enabled ? 1 : 0, (stats?.last ?? -1) + 1, rule.match, JSON.stringify(rule.conditions), JSON.stringify(rule.actions), rule.stopProcessing ? 1 : 0, u.id, t, t)
    .run();
  await audit(c, { action: "mailbox.rule_created", targetType: "mailbox", targetId: id, meta: { ruleId, name: rule.name } });
  return c.json(await requireRule(c.env.DB, id, ruleId), 201);
});

// Static paths before /:ruleId so they aren't captured as rule ids.
mailRuleRoutes.post("/:id/rules/reorder", async (c) => {
  const id = c.req.param("id");
  await requireMailbox(c.env.DB, c.get("user"), id, "editor");
  const { ids } = await parseBody(c, z.object({ ids: z.array(zId).max(MAX_RULES_PER_MAILBOX) }));
  const existing = await loadRules(c.env.DB, id);
  const known = new Set(existing.map((r) => r.id));
  if (ids.length !== known.size || new Set(ids).size !== ids.length || ids.some((r) => !known.has(r))) {
    throw new HTTPException(409, { message: "The rule list changed. Reload and try again." });
  }
  const t = now();
  await c.env.DB.batch(ids.map((ruleId, i) => c.env.DB.prepare("UPDATE mail_rules SET position = ?, updated_at = ? WHERE id = ? AND mailbox_id = ?").bind(i, t, ruleId, id)));
  await audit(c, { action: "mailbox.rules_reordered", targetType: "mailbox", targetId: id, meta: { ids } });
  return c.json(await loadRules(c.env.DB, id));
});

mailRuleRoutes.post("/:id/rules/test", async (c) => {
  const id = c.req.param("id");
  await requireMailbox(c.env.DB, c.get("user"), id);
  const draft = await parseBody(c, zRuleFields.extend({ name: z.string().max(100).default("") }));
  const t = now();
  const rule: MailRule = { ...draft, id: "draft", mailboxId: id, position: 0, hits: 0, lastHitAt: null, createdAt: t, updatedAt: t };
  return c.json(await testRule(c.env.DB, id, rule, 50));
});

mailRuleRoutes.put("/:id/rules/:ruleId", async (c) => {
  const id = c.req.param("id");
  await requireMailbox(c.env.DB, c.get("user"), id, "editor");
  await requireRule(c.env.DB, id, c.req.param("ruleId"));
  const rule = await cleanRule(c.env.DB, id, await parseBody(c, zRule));
  await c.env.DB.prepare(
    "UPDATE mail_rules SET name = ?, enabled = ?, match = ?, conditions = ?, actions = ?, stop_processing = ?, updated_at = ? WHERE id = ? AND mailbox_id = ?",
  )
    .bind(rule.name, rule.enabled ? 1 : 0, rule.match, JSON.stringify(rule.conditions), JSON.stringify(rule.actions), rule.stopProcessing ? 1 : 0, now(), c.req.param("ruleId"), id)
    .run();
  await audit(c, { action: "mailbox.rule_updated", targetType: "mailbox", targetId: id, meta: { ruleId: c.req.param("ruleId"), name: rule.name } });
  return c.json(await requireRule(c.env.DB, id, c.req.param("ruleId")));
});

mailRuleRoutes.patch("/:id/rules/:ruleId", async (c) => {
  const id = c.req.param("id");
  await requireMailbox(c.env.DB, c.get("user"), id, "editor");
  const rule = await requireRule(c.env.DB, id, c.req.param("ruleId"));
  const { enabled } = await parseBody(c, z.object({ enabled: z.boolean() }));
  await c.env.DB.prepare("UPDATE mail_rules SET enabled = ?, updated_at = ? WHERE id = ? AND mailbox_id = ?").bind(enabled ? 1 : 0, now(), rule.id, id).run();
  await audit(c, { action: enabled ? "mailbox.rule_enabled" : "mailbox.rule_disabled", targetType: "mailbox", targetId: id, meta: { ruleId: rule.id, name: rule.name } });
  return c.json({ ...rule, enabled });
});

mailRuleRoutes.delete("/:id/rules/:ruleId", async (c) => {
  const id = c.req.param("id");
  await requireMailbox(c.env.DB, c.get("user"), id, "editor");
  const rule = await requireRule(c.env.DB, id, c.req.param("ruleId"));
  await c.env.DB.prepare("DELETE FROM mail_rules WHERE id = ? AND mailbox_id = ?").bind(rule.id, id).run();
  await audit(c, { action: "mailbox.rule_deleted", targetType: "mailbox", targetId: id, meta: { ruleId: rule.id, name: rule.name } });
  return c.json({ ok: true });
});

mailRuleRoutes.post("/:id/rules/:ruleId/run", async (c) => {
  const id = c.req.param("id");
  await requireMailbox(c.env.DB, c.get("user"), id, "editor");
  const rule = await requireRule(c.env.DB, id, c.req.param("ruleId"));
  const res = await runRuleOnExisting(c.env.DB, id, rule, 500);
  await audit(c, { action: "mailbox.rule_run", targetType: "mailbox", targetId: id, meta: { ruleId: rule.id, name: rule.name, ...res } });
  return c.json(res);
});
