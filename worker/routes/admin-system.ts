import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../env";
import { audit } from "../lib/audit";
import { resend } from "../lib/resend";
import { likeEscape } from "../lib/search";
import { quotaUsage } from "../lib/send";
import { loadSettings, saveSetting } from "../lib/settings";
import { clampInt, now } from "../lib/util";
import { parseBody, zColor, zEmail, zId } from "../lib/validate";

export const adminSystemRoutes = new Hono<AppEnv>();

// ---- Overview -------------------------------------------------------------

adminSystemRoutes.get("/overview", async (c) => {
  const db = c.env.DB;
  const since = new Date(Date.now() - 13 * 86_400_000);
  since.setUTCHours(0, 0, 0, 0);
  const [usage, counts, { results: series }, { results: recentProblems }] = await Promise.all([
    quotaUsage(c.env),
    db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM users WHERE status = 'active') AS users,
           (SELECT COUNT(*) FROM users WHERE status = 'invited') AS invited,
           (SELECT COUNT(*) FROM mailboxes WHERE is_active = 1) AS mailboxes,
           (SELECT COUNT(*) FROM messages) AS messages,
           (SELECT COALESCE(SUM(size), 0) FROM messages) AS bytes,
           (SELECT COUNT(*) FROM messages WHERE status = 'scheduled') AS scheduled`,
      )
      .first<Record<string, number>>(),
    db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day, type, COUNT(*) AS n FROM email_events
         WHERE created_at >= ? GROUP BY day, type ORDER BY day`,
      )
      .bind(since.toISOString())
      .all<{ day: string; type: string; n: number }>(),
    db
      .prepare(
        `SELECT e.id, e.type, e.detail, e.recipient, e.created_at, m.subject, m.id AS message_id
         FROM email_events e LEFT JOIN messages m ON m.id = e.message_id
         WHERE e.type IN ('bounced','complained','failed','delivery_delayed','suppressed','received.unrouted')
         ORDER BY e.created_at DESC LIMIT 8`,
      )
      .all(),
  ]);
  return c.json({
    usage,
    counts,
    series,
    recentProblems,
    provider: {
      apiKey: !!c.env.RESEND_API_KEY,
      webhookSecret: !!c.env.RESEND_WEBHOOK_SECRET,
      google: !!c.env.GOOGLE_CLIENT_ID && !!c.env.GOOGLE_CLIENT_SECRET,
      webhookUrl: `${c.env.APP_URL.replace(/\/$/, "")}/webhooks/resend`,
    },
  });
});

adminSystemRoutes.get("/domains", async (c) => {
  try {
    const { data } = await resend.listDomains(c.env.RESEND_API_KEY);
    return c.json(data);
  } catch (err) {
    // Sending-only API keys can't list domains; report instead of failing the page.
    return c.json({ error: err instanceof Error ? err.message : "Unavailable" }, 200);
  }
});

// ---- Settings -------------------------------------------------------------

adminSystemRoutes.get("/settings", async (c) => c.json(await loadSettings(c.env.DB)));

const zBrand = z.object({
  companyName: z.string().trim().min(1).max(120),
  productName: z.string().trim().min(1).max(120),
  primaryDomain: z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "Enter a domain like example.com"),
  logoUrl: z
    .string()
    .trim()
    .max(400_000)
    .refine((v) => v === "" || v.startsWith("https://") || v.startsWith("/api/brand/logo") || /^data:image\/(png|jpeg|svg\+xml|webp|gif);base64,/.test(v), "Logo must be an https URL or an uploaded image"),
  monogram: z.string().trim().min(1).max(3),
  accentColor: zColor,
  radius: z.enum(["none", "sm", "md", "lg"]),
  fontFamily: z.string().trim().min(1).max(300),
  googleFont: z.string().trim().max(60).regex(/^[A-Za-z0-9 ]*$/, "Letters, numbers and spaces only"),
  loginHeadline: z.string().trim().max(120),
  loginTagline: z.string().trim().max(240),
  supportEmail: z.union([zEmail, z.literal("")]),
  footerText: z.string().trim().max(200),
  defaultFromName: z.string().trim().max(120),
});

const zPolicy = z.object({
  dailySendLimit: z.number().int().min(0).max(10_000_000),
  monthlySendLimit: z.number().int().min(0).max(100_000_000),
  maxAttachmentMb: z.number().int().min(1).max(40),
  trashRetentionDays: z.number().int().min(1).max(3650),
  logRetentionDays: z.number().int().min(0).max(3650),
  require2fa: z.boolean(),
  googleSsoEnabled: z.boolean(),
  googleAllowedDomains: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).max(20),
  googleAutoProvision: z.boolean(),
  passwordLoginEnabled: z.boolean(),
  catchAllMailboxId: zId.nullable(),
  sessionDays: z.number().int().min(1).max(90),
  trackingEnabled: z.boolean(),
});

adminSystemRoutes.put("/settings/brand", async (c) => {
  const body = await parseBody(c, zBrand.partial());
  const { brand } = await loadSettings(c.env.DB);
  const next = { ...brand, ...body };
  await saveSetting(c.env.DB, "brand", next, c.get("user").id);
  await audit(c, { action: "settings.brand_updated", targetType: "settings", meta: { fields: Object.keys(body) } });
  return c.json(next);
});

adminSystemRoutes.put("/settings/policy", async (c) => {
  const body = await parseBody(c, zPolicy.partial());
  const u = c.get("user");
  const security: (keyof typeof body)[] = ["require2fa", "passwordLoginEnabled", "googleSsoEnabled", "googleAllowedDomains", "googleAutoProvision", "sessionDays"];
  if (u.role !== "owner" && security.some((k) => k in body)) {
    throw new HTTPException(403, { message: "Only owners can change security settings." });
  }
  const { policy } = await loadSettings(c.env.DB);
  const next = { ...policy, ...body };
  await saveSetting(c.env.DB, "policy", next, u.id);
  const changed = Object.fromEntries(Object.keys(body).map((k) => [k, { from: policy[k as keyof typeof policy], to: next[k as keyof typeof next] }]));
  await audit(c, { action: "settings.policy_updated", targetType: "settings", meta: changed });
  return c.json(next);
});

/** Upload a logo into R2; it's served publicly from /api/brand/logo. */
adminSystemRoutes.post("/settings/logo", async (c) => {
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new HTTPException(400, { message: "No file uploaded" });
  if (!/^image\/(png|jpeg|svg\+xml|webp|gif)$/.test(file.type)) throw new HTTPException(400, { message: "Use a PNG, JPG, SVG, WebP or GIF" });
  if (file.size > 1024 * 1024) throw new HTTPException(413, { message: "Logo must be under 1 MB" });
  await c.env.FILES.put("brand/logo", file.stream(), { httpMetadata: { contentType: file.type } });
  const { brand } = await loadSettings(c.env.DB);
  const next = { ...brand, logoUrl: `/api/brand/logo?v=${Date.now()}` };
  await saveSetting(c.env.DB, "brand", next, c.get("user").id);
  await audit(c, { action: "settings.logo_updated", targetType: "settings" });
  return c.json(next);
});

// ---- Logs -----------------------------------------------------------------

function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    // Neutralise spreadsheet formula injection.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}

function csvResponse(name: string, rows: Record<string, unknown>[]) {
  return new Response(toCsv(rows), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}-${now().slice(0, 10)}.csv"` },
  });
}

adminSystemRoutes.get("/audit", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const action = c.req.query("action") ?? "";
  const cursor = c.req.query("cursor") ?? "";
  const csv = c.req.query("format") === "csv";
  const limit = csv ? 5000 : clampInt(c.req.query("limit"), 1, 200, 50);
  const pat = `%${likeEscape(q)}%`;
  const { results } = await c.env.DB.prepare(
    `SELECT id, created_at, actor_email, action, target_type, target_id, ip, user_agent, meta FROM audit_logs
     WHERE (?1 = '' OR actor_email LIKE ?2 ESCAPE '\\' OR action LIKE ?2 ESCAPE '\\' OR target_id LIKE ?2 ESCAPE '\\' OR meta LIKE ?2 ESCAPE '\\' OR ip LIKE ?2 ESCAPE '\\')
       AND (?3 = '' OR action LIKE ?4 ESCAPE '\\')
       AND (?5 = '' OR created_at < ?5)
     ORDER BY created_at DESC LIMIT ?6`,
  )
    .bind(q, pat, action, `${likeEscape(action)}%`, cursor, limit + 1)
    .all<Record<string, unknown> & { created_at: string }>();
  if (csv) return csvResponse("audit-log", results);
  const page = results.slice(0, limit);
  return c.json({ items: page, nextCursor: results.length > limit ? page[page.length - 1].created_at : null });
});

adminSystemRoutes.get("/events", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const type = c.req.query("type") ?? "";
  const cursor = c.req.query("cursor") ?? "";
  const csv = c.req.query("format") === "csv";
  const limit = csv ? 5000 : clampInt(c.req.query("limit"), 1, 200, 50);
  const pat = `%${likeEscape(q)}%`;
  const { results } = await c.env.DB.prepare(
    `SELECT e.id, e.created_at, e.type, e.recipient, e.detail, e.resend_id, e.message_id, m.subject, m.from_addr, mb.address AS mailbox
     FROM email_events e LEFT JOIN messages m ON m.id = e.message_id LEFT JOIN mailboxes mb ON mb.id = m.mailbox_id
     WHERE (?1 = '' OR e.recipient LIKE ?2 ESCAPE '\\' OR e.detail LIKE ?2 ESCAPE '\\' OR m.subject LIKE ?2 ESCAPE '\\' OR e.resend_id = ?1 OR m.from_addr LIKE ?2 ESCAPE '\\')
       AND (?3 = '' OR e.type = ?3)
       AND (?4 = '' OR e.created_at < ?4)
     ORDER BY e.created_at DESC LIMIT ?5`,
  )
    .bind(q, pat, type, cursor, limit + 1)
    .all<Record<string, unknown> & { created_at: string }>();
  if (csv) return csvResponse("delivery-log", results);
  const page = results.slice(0, limit);
  return c.json({ items: page, nextCursor: results.length > limit ? page[page.length - 1].created_at : null });
});

adminSystemRoutes.get("/events/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM email_events WHERE id = ?").bind(c.req.param("id")).first();
  if (!row) throw new HTTPException(404, { message: "Event not found" });
  return c.json(row);
});
