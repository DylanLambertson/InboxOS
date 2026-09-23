import type { Context } from "hono";
import type { OrgPolicy } from "@shared/brand";
import type { Role } from "@shared/types";
import type { AppEnv } from "../env";
import { audit, clientIp } from "./audit";
import { describeDevice, templates } from "./email-templates";
import { allowlistBlocks } from "./ip-allowlist";
import { getBrand } from "./settings";
import { sendSystemEmail } from "./system-mail";
import { newId, now } from "./util";

export type SignInOutcome = "success" | "failed" | "locked" | "2fa_failed" | "blocked";
export type SignInMethod = "password" | "password+2fa" | "google" | "session";

/** How far back a country or device still counts as "seen before". */
export const KNOWN_WINDOW_DAYS = 90;

export interface SignInFingerprint {
  country: string | null;
  device: string;
}

export type NewSignInReason = "country" | "device";

/**
 * Why a successful sign-in deserves an alert: a country or browser+OS not used in the
 * last 90 days. Never on the account's first recorded sign-in — everything is new then.
 */
export function newSignInReasons(current: SignInFingerprint, recent: readonly SignInFingerprint[], hasPriorSignIn: boolean): NewSignInReason[] {
  if (!hasPriorSignIn) return [];
  const reasons: NewSignInReason[] = [];
  if (current.country && !recent.some((r) => r.country === current.country)) reasons.push("country");
  if (!recent.some((r) => r.device === current.device)) reasons.push("device");
  return reasons;
}

/** ISO country of the client, from Cloudflare's request metadata (absent in local dev). */
export function requestCountry(c: Context<AppEnv>): string | null {
  const cf = (c.req.raw as Request & { cf?: { country?: unknown } }).cf;
  const code = typeof cf?.country === "string" ? cf.country.toUpperCase() : null;
  return code && /^[A-Z0-9]{2}$/.test(code) && code !== "XX" ? code : null;
}

/**
 * Record a sign-in attempt in login_events, and on success email the user if it came from a
 * new country or device. Never throws: history must not break sign-in.
 */
export async function recordSignIn(
  c: Context<AppEnv>,
  e: {
    outcome: SignInOutcome;
    method: SignInMethod;
    user?: { id: string; email: string; name?: string | null } | null;
    email?: string | null;
    reason?: string;
  },
): Promise<void> {
  const db = c.env.DB;
  const ua = c.req.header("user-agent")?.slice(0, 300) ?? null;
  const current: SignInFingerprint = { country: requestCountry(c), device: describeDevice(ua) };
  const ip = clientIp(c);
  try {
    let reasons: NewSignInReason[] = [];
    if (e.outcome === "success" && e.user) {
      // Read history before inserting this sign-in, so it doesn't count as "seen".
      const since = new Date(Date.now() - KNOWN_WINDOW_DAYS * 86_400_000).toISOString();
      const [prior, recent] = await Promise.all([
        db.prepare("SELECT 1 AS x FROM login_events WHERE user_id = ? AND outcome = 'success' LIMIT 1").bind(e.user.id).first(),
        db
          .prepare("SELECT DISTINCT country, device FROM login_events WHERE user_id = ? AND outcome = 'success' AND created_at >= ? LIMIT 500")
          .bind(e.user.id, since)
          .all<SignInFingerprint>(),
      ]);
      reasons = newSignInReasons(current, recent.results, !!prior);
    }
    await db
      .prepare(
        `INSERT INTO login_events (id, user_id, email, outcome, method, reason, ip, user_agent, device, country, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(newId(), e.user?.id ?? null, (e.user?.email ?? e.email)?.slice(0, 254) ?? null, e.outcome, e.method, e.reason ?? null, ip, ua, current.device, current.country, now())
      .run();
    if (reasons.length && e.user) {
      const user = e.user;
      c.executionCtx.waitUntil(
        getBrand(db).then((brand) =>
          sendSystemEmail(
            c.env,
            user.email,
            templates.newSignIn(brand, { name: user.name ?? undefined, reasons, device: current.device, country: current.country, appUrl: c.env.APP_URL, ctx: { ip, userAgent: ua } }),
            "security",
          ),
        ),
      );
    }
  } catch (err) {
    console.error("recordSignIn failed", err);
  }
}

/**
 * The address the allowlist is checked against. Only Cloudflare's header: X-Forwarded-For
 * is set by the client and would let anyone claim an allowed address.
 */
export const allowlistIp = (c: Context<AppEnv>) => c.req.header("cf-connecting-ip")?.trim() || null;

/**
 * Whether the IP allowlist refuses this sign-in or request; when it does, the attempt is
 * recorded in sign-in history and the audit log. Pass `user` once the account is known.
 */
export async function ipRefused(
  c: Context<AppEnv>,
  policy: Pick<OrgPolicy, "ipAllowlist" | "ipAllowlistEnforceFor">,
  e: { method: SignInMethod; user?: { id: string; email: string; role: Role } | null; email?: string | null },
): Promise<boolean> {
  const ip = allowlistIp(c);
  if (!allowlistBlocks(policy, ip, e.user?.role)) return false;
  const actor = e.user ? { id: e.user.id, email: e.user.email } : null;
  await Promise.all([
    recordSignIn(c, { outcome: "blocked", method: e.method, user: e.user, email: e.email, reason: "ip_not_allowed" }),
    audit(c, { action: "auth.ip_blocked", targetType: e.user ? "user" : undefined, targetId: e.user?.id, actor, meta: { ip, method: e.method, email: e.user?.email ?? e.email ?? null } }),
  ]);
  return true;
}
