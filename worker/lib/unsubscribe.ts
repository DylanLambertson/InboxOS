import { b64decode, b64url, escapeHtml, timingSafeEqual } from "./util";

/**
 * Unsubscribe links are signed, not stored: the token is an HMAC of the address,
 * so a link can't be edited to unsubscribe someone else.
 */
const enc = new TextEncoder();

async function sign(secret: string, email: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`unsubscribe:${email.toLowerCase()}`));
  return b64url(new Uint8Array(mac)).slice(0, 32);
}

export async function unsubscribeUrl(appUrl: string, secret: string, email: string): Promise<string> {
  const e = b64url(enc.encode(email.toLowerCase()));
  return `${appUrl.replace(/\/$/, "")}/unsubscribe?e=${e}&t=${await sign(secret, email)}`;
}

/** Returns the address the link was issued for, or null if the link is invalid. */
export async function verifyUnsubscribe(secret: string, e: string | undefined, t: string | undefined): Promise<string | null> {
  if (!e || !t || e.length > 400) return null;
  let email: string;
  try {
    email = new TextDecoder().decode(b64decode(e.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((e.length + 3) % 4)));
  } catch {
    return null;
  }
  return timingSafeEqual(await sign(secret, email), t) ? email : null;
}

/** Headers for one-click unsubscribe (RFC 8058), which Gmail and Yahoo require for bulk senders. */
export const unsubscribeHeaders = (url: string) => ({
  "List-Unsubscribe": `<${url}>`,
  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
});

export function unsubscribeFooter(url: string): { html: string; text: string } {
  return {
    html: `<p style="margin-top:24px;font-size:12px;color:#6b7280">Not interested? <a href="${escapeHtml(url)}" style="color:#6b7280">Unsubscribe</a> and we won't email you again.</p>`,
    text: `\n\n--\nNot interested? Unsubscribe: ${url}`,
  };
}

export function unsubscribePage(title: string, body: string, form?: { action: string }): string {
  const button = form
    ? `<form method="post" action="${escapeHtml(form.action)}"><button type="submit" style="margin-top:16px;padding:10px 18px;border:0;border-radius:6px;background:#111827;color:#fff;font-size:14px;cursor:pointer">Unsubscribe</button></form>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;background:#f7f5ef;font-family:system-ui,-apple-system,sans-serif;color:#111827"><main style="max-width:440px;margin:15vh auto;padding:0 16px">
<h1 style="font-size:20px;margin:0 0 8px">${escapeHtml(title)}</h1><p style="font-size:14px;line-height:1.5;color:#4b5563;margin:0">${escapeHtml(body)}</p>${button}</main></body></html>`;
}
