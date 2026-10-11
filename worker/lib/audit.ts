import type { Context } from "hono";
import type { AppEnv } from "../env";
import { newId, now } from "./util";

export interface AuditEntry {
  action: string;
  targetType?: string;
  targetId?: string | null;
  meta?: Record<string, unknown>;
  actor?: { id: string; email: string } | null;
}

export function clientIp(c: Context<AppEnv>): string | null {
  return c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
}

/** IP and device for security emails. */
export function requestContext(c: Context<AppEnv>) {
  return { ip: clientIp(c), userAgent: c.req.header("user-agent") ?? null };
}

/** Records an audit event. Never throws — audit failures must not break requests. */
export async function audit(c: Context<AppEnv>, e: AuditEntry): Promise<void> {
  const actor = e.actor === undefined ? c.get("user") ?? null : e.actor;
  try {
    await c.env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_id, actor_email, action, target_type, target_id, ip, user_agent, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        newId(),
        actor?.id ?? null,
        actor?.email ?? null,
        e.action,
        e.targetType ?? null,
        e.targetId ?? null,
        clientIp(c),
        c.req.header("user-agent")?.slice(0, 300) ?? null,
        JSON.stringify(e.meta ?? {}),
        now(),
      )
      .run();
  } catch (err) {
    console.error("audit failed", err);
  }
}

/** Records an event from a scheduled job (no request, no actor). Never throws. */
export async function auditSystem(db: D1Database, e: Omit<AuditEntry, "actor">): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO audit_logs (id, actor_id, actor_email, action, target_type, target_id, ip, user_agent, meta, created_at)
         VALUES (?, NULL, 'system', ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .bind(newId(), e.action, e.targetType ?? null, e.targetId ?? null, JSON.stringify(e.meta ?? {}), now())
      .run();
  } catch (err) {
    console.error("audit failed", err);
  }
}

/**
 * Several events from one request in a few batched writes (bulk actions and imports:
 * one entry per affected row plus a summary). Never throws.
 */
export async function auditMany(c: Context<AppEnv>, entries: AuditEntry[]): Promise<void> {
  if (!entries.length) return;
  const ip = clientIp(c);
  const ua = c.req.header("user-agent")?.slice(0, 300) ?? null;
  const t = now();
  try {
    const stmts = entries.map((e) => {
      const actor = e.actor === undefined ? c.get("user") ?? null : e.actor;
      return c.env.DB.prepare(
        `INSERT INTO audit_logs (id, actor_id, actor_email, action, target_type, target_id, ip, user_agent, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(newId(), actor?.id ?? null, actor?.email ?? null, e.action, e.targetType ?? null, e.targetId ?? null, ip, ua, JSON.stringify(e.meta ?? {}), t);
    });
    for (let i = 0; i < stmts.length; i += 100) await c.env.DB.batch(stmts.slice(i, i + 100));
  } catch (err) {
    console.error("audit failed", err);
  }
}
