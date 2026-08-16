import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import type { AppEnv, Env } from "./env";
import { runCron } from "./cron";
import { requireAdmin, requireAuth, sameOrigin } from "./lib/session";
import { getBrand } from "./lib/settings";
import { adminMailboxRoutes } from "./routes/admin-mailboxes";
import { adminSystemRoutes } from "./routes/admin-system";
import { adminUserRoutes } from "./routes/admin-users";
import { attachmentRoutes } from "./routes/attachments";
import { authRoutes } from "./routes/auth";
import { composeRoutes } from "./routes/compose";
import { contactRoutes } from "./routes/contacts";
import { labelRoutes, mailboxRoutes } from "./routes/mailboxes";
import { meRoutes } from "./routes/me";
import { messageActionRoutes } from "./routes/message-actions";
import { messageRoutes } from "./routes/messages";
import { templateRoutes } from "./routes/templates";
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
app.route("/api/auth", authRoutes);
app.route("/webhooks", webhookRoutes);

// ---- Signed-in ------------------------------------------------------------
const api = new Hono<AppEnv>();
api.use("*", requireAuth);
api.route("/me", meRoutes);
api.route("/mailboxes", mailboxRoutes);
api.route("/labels", labelRoutes);
api.route("/messages", messageActionRoutes);
api.route("/messages", messageRoutes);
api.route("/drafts", composeRoutes);
api.route("/attachments", attachmentRoutes);
api.route("/contacts", contactRoutes);
api.route("/templates", templateRoutes);

const admin = new Hono<AppEnv>();
admin.use("*", requireAdmin);
admin.route("/users", adminUserRoutes);
admin.route("/mailboxes", adminMailboxRoutes);
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
