import { b64decode, b64encode, timingSafeEqual } from "./util";

/**
 * Verifies a Resend webhook (Resend signs with Svix).
 * signed content = `${svix-id}.${svix-timestamp}.${rawBody}`, HMAC-SHA256 keyed with the
 * base64 part of the `whsec_…` secret; header holds space-separated `v1,<base64>` signatures.
 */
export async function verifySvix(
  secret: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  body: string,
  toleranceSec = 300,
): Promise<boolean> {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false;

  const keyBytes = b64decode(secret.startsWith("whsec_") ? secret.slice(6) : secret);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  const expected = b64encode(new Uint8Array(mac));

  return signature
    .split(" ")
    .map((s) => s.split(",")[1] ?? "")
    .some((sig) => timingSafeEqual(sig, expected));
}
