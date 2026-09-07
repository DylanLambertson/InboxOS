import { Hono, type Context } from "hono";
import type { AppEnv } from "../env";
import { verifyUnsubscribe, unsubscribePage } from "../lib/unsubscribe";
import { now } from "../lib/util";

/**
 * Public unsubscribe links from outreach emails. GET only shows a confirm button, because
 * link scanners open every URL in an email; the POST (the button, or a mail provider's
 * one-click request per RFC 8058) records it.
 */
export const unsubscribeRoutes = new Hono<AppEnv>();

const page = (c: Context<AppEnv>, status: 200 | 400, title: string, body: string, form?: { action: string }) =>
  c.html(unsubscribePage(title, body, form), status, { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });

unsubscribeRoutes.get("/", async (c) => {
  const email = await verifyUnsubscribe(c.env.SESSION_SECRET, c.req.query("e"), c.req.query("t"));
  if (!email) return page(c, 400, "Link not valid", "This unsubscribe link is incomplete or has been changed. Reply to the email and ask us to stop, and we will.");
  const url = new URL(c.req.url);
  return page(c, 200, "Unsubscribe", `Stop emails from us to ${email}?`, { action: url.pathname + url.search });
});

unsubscribeRoutes.post("/", async (c) => {
  const email = await verifyUnsubscribe(c.env.SESSION_SECRET, c.req.query("e"), c.req.query("t"));
  if (!email) return page(c, 400, "Link not valid", "This unsubscribe link is incomplete or has been changed.");
  await c.env.DB.prepare(
    "INSERT INTO suppressions (email, reason, detail, created_at) VALUES (?, 'unsubscribed', 'Unsubscribe link', ?) ON CONFLICT(email) DO NOTHING",
  )
    .bind(email, now())
    .run();
  return page(c, 200, "You're unsubscribed", `We won't send outreach to ${email} again.`);
});
