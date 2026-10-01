import type { Env } from "./env";
import { runDigests } from "./lib/digest";
import { recordCronRun } from "./lib/heartbeat";
import { purgeMessages } from "./lib/messages";
import { dispatchScheduled } from "./lib/send";
import { heldMailboxIds, heldParam, notHeldSql } from "./lib/legal-hold";
import { runRetention } from "./lib/retention";
import { getPolicy } from "./lib/settings";
import { now } from "./lib/util";

/** Runs every minute: scheduled sends. Once an hour (minute 0): housekeeping. */
export async function runCron(env: Env, scheduledTime: number): Promise<void> {
  // Heartbeat for Admin → Health; never let it stop the real work.
  await recordCronRun(env.DB).catch((err) => console.error("cron: heartbeat failed", err));
  const sent = await dispatchScheduled(env);
  if (sent) console.log(`cron: sent ${sent} scheduled message(s)`);
  const woke = await wakeSnoozed(env);
  if (woke) console.log(`cron: ${woke} snoozed message(s) back in the inbox`);
  // After snoozed mail wakes, so it can be in the digest.
  const digests = await runDigests(env);
  if (digests) console.log(`cron: sent ${digests} unread-mail digest(s)`);
  if (new Date(scheduledTime).getUTCMinutes() === 0) await housekeeping(env);
}

/** Snoozed mail whose time has come returns to the inbox as unread, so it's noticed again. */
export async function wakeSnoozed(env: Env): Promise<number> {
  const t = now();
  const res = await env.DB.prepare(
    "UPDATE messages SET folder = 'inbox', snoozed_until = NULL, is_read = 0, updated_at = ?1 WHERE folder = 'snoozed' AND snoozed_until <= ?1",
  )
    .bind(t)
    .run();
  return res.meta.changes ?? 0;
}

export async function housekeeping(env: Env): Promise<void> {
  const policy = await getPolicy(env.DB);
  const t = now();
  const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

  // Trash & spam retention. Held mailboxes are skipped in the query itself so they can't crowd out the batch.
  const held = await heldMailboxIds(env.DB);
  const { results: expired } = await env.DB.prepare(
    `SELECT id FROM messages WHERE ((folder = 'trash' AND trashed_at < ?1) OR (folder = 'spam' AND COALESCE(trashed_at, date) < ?1)
       OR (mailbox_id = 'system-unrouted' AND date < ?1)) AND ${notHeldSql("mailbox_id", "?2")} LIMIT 500`,
  )
    .bind(ago(policy.trashRetentionDays), heldParam(held))
    .all<{ id: string }>();
  if (expired.length) await purgeMessages(env.DB, env.FILES, expired.map((r) => r.id), held);

  await runRetention(env, policy, held);

  // Uploads that never got attached to a draft.
  const { results: orphans } = await env.DB.prepare("SELECT id, r2_key FROM attachments WHERE message_id IS NULL AND created_at < ? LIMIT 500")
    .bind(ago(1))
    .all<{ id: string; r2_key: string }>();
  if (orphans.length) {
    await env.FILES.delete(orphans.map((o) => o.r2_key));
    await env.DB.prepare(`DELETE FROM attachments WHERE id IN (${orphans.map(() => "?").join(",")})`)
      .bind(...orphans.map((o) => o.id))
      .run();
  }

  const stmts = [
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(t),
    env.DB.prepare("DELETE FROM tokens WHERE expires_at < ?").bind(ago(30)),
    env.DB.prepare("DELETE FROM webhook_receipts WHERE created_at < ?").bind(ago(7)),
    env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(Math.floor(Date.now() / 1000) - 86_400),
  ];
  if (policy.logRetentionDays > 0) {
    stmts.push(
      env.DB.prepare("DELETE FROM email_events WHERE created_at < ?").bind(ago(policy.logRetentionDays)),
      env.DB.prepare("DELETE FROM audit_logs WHERE created_at < ?").bind(ago(policy.logRetentionDays)),
      env.DB.prepare("DELETE FROM login_events WHERE created_at < ?").bind(ago(policy.logRetentionDays)),
    );
  }
  await env.DB.batch(stmts);
}
