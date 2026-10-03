import { UNROUTED_MAILBOX_ID, type Address } from "@shared/types";
import type { MailRule, RuleAction, RuleCondition } from "@shared/mail-rules";
import { evaluateRules, fieldsUsed, type RuleMessage, type RuleOutcome, type StepBudget } from "./rules-engine";
import { featureEnabled } from "./features";
import { now, parseJson } from "./util";

/** Database side of mail rules: loading, applying outcomes, and bulk runs. */

export interface RuleRow {
  id: string;
  mailbox_id: string;
  name: string;
  enabled: number;
  position: number;
  match: "all" | "any";
  conditions: string;
  actions: string;
  stop_processing: number;
  hits: number;
  last_hit_at: string | null;
  created_at: string;
  updated_at: string;
}

export const toRule = (r: RuleRow): MailRule => ({
  id: r.id,
  mailboxId: r.mailbox_id,
  name: r.name,
  enabled: !!r.enabled,
  position: r.position,
  match: r.match === "any" ? "any" : "all",
  conditions: parseJson<RuleCondition[]>(r.conditions, []),
  actions: parseJson<RuleAction[]>(r.actions, []),
  stopProcessing: !!r.stop_processing,
  hits: r.hits,
  lastHitAt: r.last_hit_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export async function loadRules(db: D1Database, mailboxId: string, enabledOnly = false): Promise<MailRule[]> {
  const { results } = await db
    .prepare(`SELECT * FROM mail_rules WHERE mailbox_id = ? ${enabledOnly ? "AND enabled = 1" : ""} ORDER BY position, created_at`)
    .bind(mailboxId)
    .all<RuleRow>();
  return results.map(toRule);
}

/**
 * Saved contacts and people we've written to count; auto-collected senders don't.
 * Contacts are org-wide in this app, so this is "known to the team", not per mailbox.
 */
const KNOWN_CONTACT = "(is_saved = 1 OR times_contacted > 0)";

async function knownContacts(db: D1Database, emails: string[]): Promise<Set<string>> {
  const uniq = [...new Set(emails.map((e) => e.toLowerCase()).filter(Boolean))].slice(0, 90);
  if (!uniq.length) return new Set();
  const { results } = await db
    .prepare(`SELECT lower(email) AS email FROM contacts WHERE email IN (${uniq.map(() => "?").join(",")}) AND ${KNOWN_CONTACT}`)
    .bind(...uniq)
    .all<{ email: string }>();
  return new Set(results.map((r) => r.email));
}

/**
 * Statements that apply one outcome to stored messages (at most 50 ids, within D1's
 * bound-parameter limit). Labels are checked against the mailbox.
 */
function outcomeStatements(db: D1Database, mailboxId: string, ids: string[], o: RuleOutcome, t: string): D1PreparedStatement[] {
  if (!ids.length) return [];
  const stmts: D1PreparedStatement[] = [];
  const ph = ids.map(() => "?").join(",");
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (o.folder === "trash") {
    sets.push("folder_before_trash = folder", "folder = 'trash'", "trashed_at = ?");
    binds.push(t);
  } else if (o.folder === "spam") {
    // Spam retention counts from trashed_at when set, so old mail filed now isn't purged at once.
    sets.push("folder = 'spam'", "trashed_at = ?");
    binds.push(t);
  } else if (o.folder) {
    sets.push("folder = ?");
    binds.push(o.folder);
  }
  if (o.read) sets.push("is_read = 1");
  if (o.starred) sets.push("is_starred = 1");
  if (o.important) sets.push("priority = 'high'");
  if (sets.length) {
    stmts.push(db.prepare(`UPDATE messages SET ${sets.join(", ")}, updated_at = ? WHERE mailbox_id = ? AND id IN (${ph})`).bind(...binds, t, mailboxId, ...ids));
  }
  for (const labelId of o.labelIds) {
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO message_labels (message_id, label_id)
           SELECT m.id, l.id FROM messages m JOIN labels l ON l.id = ? AND l.mailbox_id = m.mailbox_id
           WHERE m.mailbox_id = ? AND m.id IN (${ph})`,
        )
        .bind(labelId, mailboxId, ...ids),
    );
  }
  return stmts;
}

function hitStatement(db: D1Database, ruleIds: string[], t: string, count = 1): D1PreparedStatement | null {
  if (!ruleIds.length) return null;
  return db
    .prepare(`UPDATE mail_rules SET hits = hits + ?, last_hit_at = ? WHERE id IN (${ruleIds.map(() => "?").join(",")})`)
    .bind(count, t, ...ruleIds);
}

/**
 * Evaluate a mailbox's rules for a message that is about to be stored. Returns the
 * final folder (callers use it to decide on notifications and auto-replies) and
 * statements to run in the same batch, after the message INSERT.
 */
export async function applyRulesOnIngest(
  db: D1Database,
  args: { mailboxId: string; messageId: string; folder: string; message: Omit<RuleMessage, "senderInContacts"> },
): Promise<{ folder: string; read: boolean; statements: D1PreparedStatement[] }> {
  // Only mail headed for the inbox is filtered; blocked senders and unrouted mail stay put.
  if (args.folder !== "inbox" || args.mailboxId === UNROUTED_MAILBOX_ID) return { folder: args.folder, read: false, statements: [] };
  // Mail rules switched off in Admin > Features: rules are kept but don't run.
  if (!(await featureEnabled(db, "mailRules"))) return { folder: args.folder, read: false, statements: [] };
  const rules = await loadRules(db, args.mailboxId, true);
  if (!rules.length) return { folder: args.folder, read: false, statements: [] };
  const msg: RuleMessage = { ...args.message };
  if (fieldsUsed(rules).has("sender_contact")) msg.senderInContacts = (await knownContacts(db, [msg.from.email])).size > 0;
  const o = evaluateRules(msg, rules);
  if (!o.matched.length) return { folder: args.folder, read: false, statements: [] };
  const t = now();
  const statements = outcomeStatements(db, args.mailboxId, [args.messageId], o, t);
  statements.push(hitStatement(db, o.matched, t)!);
  return { folder: o.folder ?? args.folder, read: o.read, statements };
}

interface MessageRow {
  id: string;
  from_addr: string;
  from_name: string;
  to_json: string;
  cc_json: string;
  subject: string;
  text_body: string;
  headers_json: string;
  has_attachments: number;
  size: number;
  date: string;
}

/** Select stored messages for evaluation, skipping big columns the rules don't read. */
async function selectMessages(db: D1Database, rules: MailRule[], where: string, binds: unknown[], limit: number): Promise<MessageRow[]> {
  const used = fieldsUsed(rules.map((r) => ({ ...r, enabled: true })));
  const body = used.has("body") ? "text_body" : "'' AS text_body";
  const headers = used.has("header") ? "headers_json" : "'{}' AS headers_json";
  const { results } = await db
    .prepare(
      `SELECT id, from_addr, from_name, to_json, cc_json, subject, ${body}, ${headers}, has_attachments, size, date
       FROM messages WHERE ${where} ORDER BY date DESC, id DESC LIMIT ?`,
    )
    .bind(...binds, limit)
    .all<MessageRow>();
  return results;
}

async function toRuleMessages(db: D1Database, rows: MessageRow[], rules: MailRule[]): Promise<RuleMessage[]> {
  const contacts = fieldsUsed(rules.map((r) => ({ ...r, enabled: true }))).has("sender_contact")
    ? await knownContacts(db, rows.map((r) => r.from_addr))
    : new Set<string>();
  return rows.map((r) => ({
    from: { email: r.from_addr, name: r.from_name || undefined },
    to: parseJson<Address[]>(r.to_json, []),
    cc: parseJson<Address[]>(r.cc_json, []),
    subject: r.subject,
    text: r.text_body,
    hasAttachments: !!r.has_attachments,
    size: r.size,
    headers: parseJson<Record<string, string>>(r.headers_json, {}),
    senderInContacts: contacts.has(r.from_addr.toLowerCase()),
  }));
}

/** Dry run: which of the latest received messages a draft rule would match. */
export async function testRule(db: D1Database, mailboxId: string, rule: MailRule, limit = 50) {
  const rows = await selectMessages(db, [rule], "mailbox_id = ? AND direction = 'inbound' AND folder NOT IN ('trash','drafts')", [mailboxId], limit);
  const msgs = await toRuleMessages(db, rows, [rule]);
  const live = { ...rule, enabled: true, stopProcessing: false };
  const budget: StepBudget = { left: 5_000_000 };
  const matches = rows
    .filter((_, i) => evaluateRules(msgs[i], [live], budget).matched.length > 0)
    .map((r) => ({ id: r.id, from: r.from_name ? `${r.from_name} <${r.from_addr}>` : r.from_addr, subject: r.subject, date: r.date }));
  return { checked: rows.length, matches };
}

/** Apply one rule to the newest inbox messages, in chunks so no batch or query grows too big. */
export async function runRuleOnExisting(db: D1Database, mailboxId: string, rule: MailRule, max = 500): Promise<{ checked: number; matched: number }> {
  const CHUNK = 50;
  const live = { ...rule, enabled: true, stopProcessing: false };
  // One budget for the whole run keeps a pathological wildcard from burning the request's CPU.
  const budget: StepBudget = { left: 20_000_000 };
  let checked = 0;
  let matched = 0;
  let cursor: { date: string; id: string } | null = null;
  while (checked < max) {
    const where = cursor
      ? "mailbox_id = ? AND folder = 'inbox' AND direction = 'inbound' AND (date < ? OR (date = ? AND id < ?))"
      : "mailbox_id = ? AND folder = 'inbox' AND direction = 'inbound'";
    const binds = cursor ? [mailboxId, cursor.date, cursor.date, cursor.id] : [mailboxId];
    const rows = await selectMessages(db, [rule], where, binds, Math.min(CHUNK, max - checked));
    if (!rows.length) break;
    checked += rows.length;
    cursor = { date: rows[rows.length - 1].date, id: rows[rows.length - 1].id };
    const msgs = await toRuleMessages(db, rows, [rule]);
    const t = now();
    // A single rule yields the same outcome for every match, so a chunk needs only a few statements.
    let outcome: RuleOutcome | null = null;
    const ids: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const o = evaluateRules(msgs[i], [live], budget);
      if (!o.matched.length) continue;
      outcome = o;
      ids.push(rows[i].id);
    }
    if (outcome && ids.length) {
      matched += ids.length;
      await db.batch([...outcomeStatements(db, mailboxId, ids, outcome, t), hitStatement(db, [rule.id], t, ids.length)!]);
    }
    if (rows.length < CHUNK) break;
  }
  return { checked, matched };
}
