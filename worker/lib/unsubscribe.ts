import { b64decode, b64url, escapeHtml, timingSafeEqual } from "./util";

/**
 * Unsubscribe links are signed, not stored: the token is an HMAC of the address,
 * so a link can't be edited to unsubscribe someone else.
 */
const enc = new TextEncoder();

/** HMAC of `<purpose>:<value>`; the purpose prefix keeps one kind of link from passing as another. */
async function signPurpose(secret: string, purpose: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${purpose}:${value}`));
  return b64url(new Uint8Array(mac)).slice(0, 32);
}

const sign = (secret: string, email: string) => signPurpose(secret, "unsubscribe", email.toLowerCase());

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

/**
 * "Turn off this digest" links: signed over the user and their current personal
 * address, so changing the address retires old links. Lives at /api/digest/off
 * (not /unsubscribe, which would block every email to the address).
 */
export async function digestOffUrl(appUrl: string, secret: string, userId: string, personalEmail: string): Promise<string> {
  const t = await signPurpose(secret, "digest-off", `${userId}:${personalEmail.toLowerCase()}`);
  return `${appUrl.replace(/\/$/, "")}/api/digest/off?u=${encodeURIComponent(userId)}&t=${t}`;
}

export async function verifyDigestOff(secret: string, userId: string | undefined, personalEmail: string | null, t: string | undefined): Promise<boolean> {
  if (!userId || !personalEmail || !t || userId.length > 100) return false;
  return timingSafeEqual(await signPurpose(secret, "digest-off", `${userId}:${personalEmail.toLowerCase()}`), t);
}
