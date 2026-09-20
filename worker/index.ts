import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import type { AppEnv, Env } from "./env";
import { runCron } from "./cron";
import { requireAuth, requireConsole, sameOrigin } from "./lib/session";
import { getBrand } from "./lib/settings";
import { adminApiKeyRoutes } from "./routes/admin-apikeys";
import { adminSuppressionRoutes } from "./routes/admin-suppressions";
import { adminMailboxRoutes } from "./routes/admin-mailboxes";
import { adminSystemRoutes } from "./routes/admin-system";
import { adminTrafficRoutes } from "./routes/admin-traffic";
import { adminUserRoutes } from "./routes/admin-users";
import { apiV1Routes } from "./routes/api-v1";
import { attachmentRoutes } from "./routes/attachments";
import { authRoutes } from "./routes/auth";
import { composeRoutes } from "./routes/compose";
import { contactRoutes } from "./routes/contacts";
import { digestPublicRoutes, digestSettingsRoutes } from "./routes/digest";
import { labelRoutes, mailboxRoutes } from "./routes/mailboxes";
import { mcpRoutes } from "./routes/mcp";
import { pushRoutes } from "./routes/push";
import { meRoutes } from "./routes/me";
import { messageActionRoutes } from "./routes/message-actions";
import { messageRoutes } from "./routes/messages";
import { templateRoutes } from "./routes/templates";
import { unsubscribeRoutes } from "./routes/unsubscribe";
import { webhookRoutes } from "./routes/webhooks";

const app = new Hono<AppEnv>();

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message || "Request failed" }, err.status);
  }
  console.error("unhandled", c.req.method, c.req.path, err);
  return c.json({ error: "Something went wrong. Please try again." }, 500);
});

app.use(
  "/api/*",
  secureHeaders({
    xFrameOptions: "DENY",
    referrerPolicy: "same-origin",
    crossOriginResourcePolicy: "same-origin",
  }),
);
app.use("/api/*", async (c, next) => {
  await next();
  if (!c.res.headers.has("Cache-Control")) c.res.headers.set("Cache-Control", "no-store");
});
app.use("/api/*", sameOrigin);

// ---- Public ---------------------------------------------------------------
app.get("/api/health", (c) => c.json({ ok: true }));
app.get("/api/brand", async (c) => c.json(await getBrand(c.env.DB)));
app.get("/api/brand/logo", async (c) => {
  const obj = await c.env.FILES.get("brand/logo");
  if (!obj) return c.notFound();
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType ?? "image/png",
      "Cache-Control": "public, max-age=86400",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
// ---- Installable app (PWA) -------------------------------------------------
/** Home-screen icons generated from the brand (Admin → Branding), or the built-in defaults. */
const APP_ICONS = new Set(["icon-192", "icon-512", "maskable-512", "apple-touch-icon"]);
app.get("/api/brand/icons/:name{[a-z0-9-]+\\.png}", async (c) => {
  const name = c.req.param("name").replace(/\.png$/, "");
  if (!APP_ICONS.has(name)) return c.notFound();
  const obj = await c.env.FILES.get(`brand/icons/${name}.png`);
  if (!obj) return c.redirect(`/icons/${name}.png`, 302);
  return new Response(obj.body, {
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" },
  });
});
app.get("/manifest.webmanifest", async (c) => {
  const brand = await getBrand(c.env.DB);
  const icon = (name: string, size: number, purpose = "any") => ({ src: `/api/brand/icons/${name}.png`, sizes: `${size}x${size}`, type: "image/png", purpose });
  return c.json(
    {
      id: "/",
      name: brand.productName,
      short_name: brand.productName.length > 12 ? brand.monogram : brand.productName,
      description: `${brand.companyName} team email`,
      start_url: "/?source=pwa",
      scope: "/",
      display: "standalone",
      orientation: "any",
      background_color: "#0e0e10",
      theme_color: brand.accentColor,
      icons: [icon("icon-192", 192), icon("icon-512", 512), icon("maskable-512", 512, "maskable")],
    },
    200,
    { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=300" },
  );
});

app.route("/api/auth", authRoutes);
app.route("/api/digest", digestPublicRoutes);
app.route("/webhooks", webhookRoutes);
app.route("/unsubscribe", unsubscribeRoutes);

// ---- API keys (other services and MCP clients) -------------------------
app.route("/api/v1", apiV1Routes);
app.route("/mcp", mcpRoutes);

// ---- Signed-in ------------------------------------------------------------
const api = new Hono<AppEnv>();
api.use("*", requireAuth);
api.route("/me", meRoutes);
api.route("/me", digestSettingsRoutes);
api.route("/push", pushRoutes);
api.route("/mailboxes", mailboxRoutes);
api.route("/labels", labelRoutes);
api.route("/messages", messageActionRoutes);
api.route("/messages", messageRoutes);
api.route("/drafts", composeRoutes);
api.route("/attachments", attachmentRoutes);
api.route("/contacts", contactRoutes);
api.route("/templates", templateRoutes);

const admin = new Hono<AppEnv>();
admin.use("*", requireConsole);
admin.route("/users", adminUserRoutes);
admin.route("/mailboxes", adminMailboxRoutes);
admin.route("/traffic", adminTrafficRoutes);
admin.route("/api-keys", adminApiKeyRoutes);
admin.route("/suppressions", adminSuppressionRoutes);
admin.route("/", adminSystemRoutes);
api.route("/admin", admin);

app.route("/api", api);
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runCron(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
