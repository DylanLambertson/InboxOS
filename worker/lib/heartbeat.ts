/**
 * Cron heartbeat: each scheduled run stamps the time, so Admin → Health can tell
 * when the every-minute trigger stopped. Stored as a settings row (no migration).
 */
const KEY = "cron.heartbeat";

export async function recordCronRun(db: D1Database, at = new Date()): Promise<void> {
  const t = at.toISOString();
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, NULL)
       ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3`,
    )
    .bind(KEY, JSON.stringify(t), t)
    .run();
}

export async function lastCronRun(db: D1Database): Promise<string | null> {
  const row = await db.prepare("SELECT updated_at FROM settings WHERE key = ?").bind(KEY).first<{ updated_at: string }>();
  return row?.updated_at ?? null;
}
