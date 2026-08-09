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
