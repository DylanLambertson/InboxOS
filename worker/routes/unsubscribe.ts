import { Hono, type Context } from "hono";
import type { AppEnv } from "../env";
import { getBrand } from "../lib/settings";
import { verifyUnsubscribe } from "../lib/unsubscribe";
import { reasonLabel, renderUnsubscribePage, UNSUBSCRIBE_CSP, type UnsubscribeView } from "../lib/unsubscribe-page";
import { now } from "../lib/util";

/**
 * Public unsubscribe links from outreach emails. GET only shows a confirm button, because
 * link scanners open every URL in an email; the POST (the button, or a mail provider's
 * one-click request per RFC 8058) records it. Everything stays on /unsubscribe (the only
 * path routed to the Worker); `?action=resubscribe` undoes it and `?stay=1` is the
 * "keep me subscribed" answer.
 */
export const unsubscribeRoutes = new Hono<AppEnv>();

async function page(c: Context<AppEnv>, view: UnsubscribeView, status: 200 | 400 = 200) {
  const brand = await getBrand(c.env.DB);
  return c.html(renderUnsubscribePage(brand, view), status, {
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex",
    "Content-Security-Policy": UNSUBSCRIBE_CSP,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
}

/** The link's own query (e + t), with optional extras, for forms and links on the page. */
function linkWith(c: Context<AppEnv>, extra: Record<string, string> = {}): string {
  const url = new URL(c.req.url);
  const params = new URLSearchParams({ e: url.searchParams.get("e") ?? "", t: url.searchParams.get("t") ?? "", ...extra });
  return `${url.pathname}?${params}`;
}

const verify = (c: Context<AppEnv>) => verifyUnsubscribe(c.env.SESSION_SECRET, c.req.query("e"), c.req.query("t"));

unsubscribeRoutes.get("/", async (c) => {
  const email = await verify(c);
  if (!email) return page(c, { kind: "invalid" }, 400);
  if (c.req.query("stay") === "1") return page(c, { kind: "stayed" });
  const existing = await c.env.DB.prepare("SELECT reason FROM suppressions WHERE email = ?").bind(email).first<{ reason: string }>();
  if (existing?.reason === "unsubscribed") {
    return page(c, { kind: "done", email, already: true, resubscribeAction: linkWith(c, { action: "resubscribe" }) });
  }
  return page(c, { kind: "confirm", email, action: linkWith(c), stayUrl: linkWith(c, { stay: "1" }) });
});

unsubscribeRoutes.post("/", async (c) => {
  const email = await verify(c);
  if (!email) return page(c, { kind: "invalid" }, 400);

  if (c.req.query("action") === "resubscribe") {
    // Only undoes their own unsubscribe: bounces and complaints stay blocked.
    await c.env.DB.prepare("DELETE FROM suppressions WHERE email = ? AND reason = 'unsubscribed'").bind(email).run();
    return page(c, { kind: "resubscribed", email });
  }

  // The page's form sends `reason`; a provider's one-click POST sends List-Unsubscribe=One-Click.
  let reason: string | undefined;
  let oneClick = false;
  try {
    const form = await c.req.parseBody();
    reason = typeof form.reason === "string" ? form.reason : undefined;
    oneClick = form["List-Unsubscribe"] === "One-Click";
  } catch {
    /* empty or non-form body: still a valid unsubscribe */
  }
  const label = reasonLabel(reason);
  const detail = oneClick ? "One-click unsubscribe (mail app)" : label ? `Unsubscribe link · ${label}` : "Unsubscribe link";
  await c.env.DB.prepare(
    "INSERT INTO suppressions (email, reason, detail, created_at) VALUES (?, 'unsubscribed', ?, ?) ON CONFLICT(email) DO NOTHING",
  )
    .bind(email, detail, now())
    .run();
  if (oneClick) return c.body(null, 200);
  return page(c, { kind: "done", email, resubscribeAction: linkWith(c, { action: "resubscribe" }) });
});
