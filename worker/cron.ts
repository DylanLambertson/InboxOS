import type { Env } from "./env";
import { purgeMessages } from "./lib/messages";
import { dispatchScheduled } from "./lib/send";
import { getPolicy } from "./lib/settings";
import { now } from "./lib/util";

/** Runs every minute: scheduled sends. Once an hour (minute 0): housekeeping. */
export async function runCron(env: Env, scheduledTime: number): Promise<void> {
  const sent = await dispatchScheduled(env);
  if (sent) console.log(`cron: sent ${sent} scheduled message(s)`);
  if (new Date(scheduledTime).getUTCMinutes() === 0) await housekeeping(env);
}

export async function housekeeping(env: Env): Promise<void> {
  const policy = await getPolicy(env.DB);
  const t = now();
  const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

  // Trash & spam retention.
  const { results: expired } = await env.DB.prepare(
    `SELECT id FROM messages WHERE (folder = 'trash' AND trashed_at < ?1) OR (folder = 'spam' AND date < ?1) LIMIT 500`,
  )
    .bind(ago(policy.trashRetentionDays))
    .all<{ id: string }>();
  if (expired.length) await purgeMessages(env.DB, env.FILES, expired.map((r) => r.id));

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
    );
  }
  await env.DB.batch(stmts);
}
