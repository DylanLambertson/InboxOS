import type { OrgPolicy } from "@shared/brand";
import type { Env } from "../env";
import { auditSystem } from "./audit";
import { purgeMessages } from "./messages";

/**
 * Retention policies: "permanently delete mail older than N days", set for the
 * org and optionally overridden per mailbox. Off by default. Enforced hourly by
 * cron in bounded chunks; held mailboxes are never touched.
 */

export type RetentionScope = "all" | "archive";
export interface RetentionRule {
  days: number;
  scope: RetentionScope;
}
export interface MailboxRetention {
  retention_days: number | null;
  retention_scope: string | null;
}

/** Most messages one cron run deletes, so housekeeping stays inside Worker limits. */
export const RETENTION_RUN_BUDGET = 1000;
const CHUNK = 200;

/**
 * The rule that applies to a mailbox, or null when nothing should be deleted.
 * A mailbox override (days set) replaces the org rule entirely; 0 days = keep forever.
 */
export function effectiveRule(org: Pick<OrgPolicy, "retentionDays" | "retentionScope">, mb: MailboxRetention): RetentionRule | null {
  const override = mb.retention_days !== null && mb.retention_days !== undefined;
  const days = override ? mb.retention_days! : org.retentionDays;
  if (!days || days <= 0) return null;
  const scope = override ? mb.retention_scope : org.retentionScope;
  return { days, scope: scope === "archive" ? "archive" : "all" };
}

/** Drafts and scheduled sends are work in progress, never retention targets. */
export function folderInScope(folder: string, scope: RetentionScope): boolean {
  return scope === "archive" ? folder === "archive" : folder !== "drafts" && folder !== "scheduled";
}

export const scopeSql = (scope: RetentionScope) => (scope === "archive" ? "folder = 'archive'" : "folder NOT IN ('drafts','scheduled')");

export const retentionCutoff = (days: number, nowMs = Date.now()) => new Date(nowMs - days * 86_400_000).toISOString();

interface MailboxRow extends MailboxRetention {
  id: string;
  address: string;
}

async function retentionMailboxes(db: D1Database): Promise<MailboxRow[]> {
  const { results } = await db
    .prepare("SELECT id, address, retention_days, retention_scope FROM mailboxes WHERE is_system = 0 ORDER BY address")
    .all<MailboxRow>();
  return results;
}

/** Cron: apply retention rules, at most RETENTION_RUN_BUDGET messages per run. */
export async function runRetention(env: Env, policy: OrgPolicy, held: Set<string>): Promise<number> {
  const boxes = await retentionMailboxes(env.DB);
  const counts: Record<string, number> = {};
  let budget = RETENTION_RUN_BUDGET;
  for (const mb of boxes) {
    const rule = effectiveRule(policy, mb);
    if (!rule || held.has(mb.id)) continue;
    const cutoff = retentionCutoff(rule.days);
    while (budget > 0) {
      const { results } = await env.DB.prepare(`SELECT id FROM messages WHERE mailbox_id = ? AND date < ? AND ${scopeSql(rule.scope)} LIMIT ?`)
        .bind(mb.id, cutoff, Math.min(CHUNK, budget))
        .all<{ id: string }>();
      if (!results.length) break;
      const { purged } = await purgeMessages(env.DB, env.FILES, results.map((r) => r.id), held);
      budget -= results.length;
      if (purged) counts[mb.address] = (counts[mb.address] ?? 0) + purged;
      if (results.length < CHUNK || !purged) break;
    }
    if (budget <= 0) break;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total) {
    await auditSystem(env.DB, { action: "retention.purged", targetType: "messages", meta: { count: total, mailboxes: counts, more: budget <= 0 } });
    console.log(`cron: retention deleted ${total} message(s)`);
  }
  return total;
}

export interface RetentionPreview {
  total: number;
  heldExcluded: number;
  mailboxes: { id: string; address: string; count: number; held: boolean; rule: RetentionRule | null }[];
}

/**
 * How many messages a retention setting would delete right now. Pass `org` to
 * preview an org-wide change (mailbox overrides still apply), or `mailbox` to
 * preview one mailbox's override.
 */
export async function previewRetention(
  db: D1Database,
  held: Set<string>,
  input: { org: Pick<OrgPolicy, "retentionDays" | "retentionScope"> } | { mailboxId: string; override: MailboxRetention; org: Pick<OrgPolicy, "retentionDays" | "retentionScope"> },
): Promise<RetentionPreview> {
  const all = await retentionMailboxes(db);
  const boxes = "mailboxId" in input ? all.filter((b) => b.id === input.mailboxId).map((b) => ({ ...b, ...input.override })) : all;
  const ruled = boxes.map((b) => ({ ...b, rule: effectiveRule(input.org, b) }));
  const withRule = ruled.filter((b) => b.rule);
  const counts = withRule.length
    ? await db.batch(
        withRule.map((b) =>
          db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE mailbox_id = ? AND date < ? AND ${scopeSql(b.rule!.scope)}`).bind(b.id, retentionCutoff(b.rule!.days)),
        ),
      )
    : [];
  const out: RetentionPreview = { total: 0, heldExcluded: 0, mailboxes: [] };
  ruled.forEach((b) => {
    const i = withRule.indexOf(b);
    const count = i >= 0 ? ((counts[i].results[0] as { n: number } | undefined)?.n ?? 0) : 0;
    const isHeld = held.has(b.id);
    if (isHeld) out.heldExcluded += count;
    else out.total += count;
    out.mailboxes.push({ id: b.id, address: b.address, count, held: isHeld, rule: b.rule });
  });
  return out;
}
