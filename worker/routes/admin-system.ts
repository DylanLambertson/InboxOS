import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../env";
import { audit, requestContext } from "../lib/audit";
import { renderEmail } from "../lib/email-layout";
import { templates, type TemplateName } from "../lib/email-templates";
import { resend } from "../lib/resend";
import { likeEscape } from "../lib/search";
import { getOverview } from "../lib/overview";
import { syncDomainAliases } from "../lib/domains";
import { sanitizeTheme } from "@shared/theme";
import { loadSettings, saveSetting } from "../lib/settings";
import { allowlistLockoutProblem, isValidCidr } from "../lib/ip-allowlist";
import { allowlistIp } from "../lib/sign-ins";
import { clampInt, now } from "../lib/util";
import { parseBody, zEmail, zId } from "../lib/validate";

export const adminSystemRoutes = new Hono<AppEnv>();

// ---- Overview -------------------------------------------------------------

adminSystemRoutes.get("/overview", async (c) => c.json(await getOverview(c.env, c.req.query("refresh") === "1")));

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

const zDomain = z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "Enter a domain like example.com");

const zBrand = z.object({
  companyName: z.string().trim().min(1).max(120),
  productName: z.string().trim().min(1).max(120),
  primaryDomain: zDomain,
  additionalDomains: z.array(zDomain).max(10),
  logoUrl: z
    .string()
    .trim()
    .max(400_000)
    .refine((v) => v === "" || v.startsWith("https://") || v.startsWith("/api/brand/logo") || /^data:image\/(png|jpeg|svg\+xml|webp|gif);base64,/.test(v), "Logo must be an https URL or an uploaded image"),
  monogram: z.string().trim().min(1).max(3),
  // Partial token updates are merged over the current theme and sanitized (see shared/theme.ts).
  theme: z.record(z.string(), z.unknown()),
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
  digestDetail: z.enum(["subjects", "count", "off"]),
  ipAllowlist: z.array(z.string().trim().max(64).refine(isValidCidr, "Enter IP addresses or ranges like 203.0.113.0/24 or 2001:db8::/32")).max(100),
  ipAllowlistEnforceFor: z.enum(["everyone", "admins"]),
});

adminSystemRoutes.put("/settings/brand", async (c) => {
  const body = await parseBody(c, zBrand.partial());
  const { brand } = await loadSettings(c.env.DB);
  const next = { ...brand, ...body, theme: body.theme ? sanitizeTheme(body.theme, brand.theme) : brand.theme };
  await saveSetting(c.env.DB, "brand", next, c.get("user").id);
  // A newly added domain gives every existing mailbox its address there.
  if (body.primaryDomain !== undefined || body.additionalDomains !== undefined) await syncDomainAliases(c.env.DB);
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
  if ("ipAllowlist" in body || "ipAllowlistEnforceFor" in body) {
    const problem = allowlistLockoutProblem(allowlistIp(c), next.ipAllowlist);
    if (problem) throw new HTTPException(400, { message: problem });
  }
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

/**
 * Home-screen icons, rendered in the admin's browser from the logo or monogram
 * (Workers can't rasterize images without a heavy dependency) and stored in R2.
 */
adminSystemRoutes.post("/settings/icons", async (c) => {
  const form = await c.req.formData();
  const names = ["icon-192", "icon-512", "maskable-512", "apple-touch-icon"] as const;
  const files: [string, File][] = [];
  for (const name of names) {
    const file = form.get(name);
    if (!(file instanceof File)) throw new HTTPException(400, { message: `Missing ${name}` });
    if (file.type !== "image/png" || file.size > 512 * 1024) throw new HTTPException(400, { message: `${name} must be a PNG under 512 KB` });
    // Check the PNG signature rather than trusting the declared type.
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    if (head[0] !== 0x89 || head[1] !== 0x50 || head[2] !== 0x4e || head[3] !== 0x47) throw new HTTPException(400, { message: `${name} isn't a PNG` });
    files.push([name, file]);
  }
  await Promise.all(files.map(([name, file]) => c.env.FILES.put(`brand/icons/${name}.png`, file.stream(), { httpMetadata: { contentType: "image/png" } })));
  await audit(c, { action: "settings.app_icons_updated", targetType: "settings" });
  return c.json({ ok: true });
});

// ---- System email previews ----------------------------------------------

/** Render a transactional email with sample data so admins can see the branded result. */
adminSystemRoutes.get("/email-preview/:name", async (c) => {
  const name = c.req.param("name") as TemplateName;
  if (!(name in templates)) throw new HTTPException(404, { message: "Unknown template" });
  const { brand } = await loadSettings(c.env.DB);
  const me = c.get("user");
  const app = c.env.APP_URL.replace(/\/$/, "");
  const ctx = requestContext(c);
  const sample = `${app}/preview-link`;
  const content = {
    invite: () => templates.invite(brand, { name: "Jordan Lee", email: `jordan@${brand.primaryDomain}`, inviter: me.name || me.email, url: sample, days: 7 }),
    reset: () => templates.reset(brand, { name: me.name, url: sample, expires: "1 hour", ctx }),
    passwordChanged: () => templates.passwordChanged(brand, { name: me.name, appUrl: app, ctx }),
    twoFactor: () => templates.twoFactor(brand, { name: me.name, enabled: true, appUrl: app, ctx }),
    newSignIn: () =>
      templates.newSignIn(brand, { name: me.name, reasons: ["country", "device"], device: "Chrome on Windows", country: "DE", appUrl: app, ctx: { ip: ctx.ip ?? "203.0.113.7", userAgent: null } }),
    passkeyAdded: () => templates.passkeyAdded(brand, { name: me.name, passkey: "iPhone", host: new URL(app).hostname, appUrl: app, ctx }),
    welcome: () => templates.welcome(brand, { name: "Jordan Lee", email: `jordan@${brand.primaryDomain}`, appUrl: app, mailboxes: [`jordan@${brand.primaryDomain}`, `support@${brand.primaryDomain}`] }),
    verifyPersonalEmail: () => templates.verifyPersonalEmail(brand, { name: me.name, url: sample, account: me.email }),
    personalEmailAdded: () => templates.personalEmailAdded(brand, { name: me.name, masked: "jo***@gmail.com", appUrl: app, ctx }),
    unreadDigest: () =>
      templates.unreadDigest(brand, {
        name: me.name,
        total: 4,
        detail: "subjects",
        openUrl: `${app}/mail`,
        offUrl: sample,
        groups: [
          {
            mailbox: `hello@${brand.primaryDomain}`,
            count: 3,
            items: [
              { from: "Priya Shah", subject: "Re: Website redesign proposal", url: sample },
              { from: "Jordan Lee", subject: "Intro: Jordan <> Acme", url: sample },
              { from: "Stripe", subject: "Your receipt #2041", url: sample },
            ],
          },
          { mailbox: `support@${brand.primaryDomain}`, count: 1, items: [{ from: "Alex Rivera", subject: "Q4 campaign brief", url: sample }] },
        ],
      }),
  }[name]();
  const { html } = renderEmail(brand, app, content);
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
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
