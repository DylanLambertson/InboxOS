import { b64decode, b64encode } from "./util";

/**
 * Encryption at rest for credentials kept in D1 (the email provider's API key,
 * webhook signing secrets). The key is derived from SESSION_SECRET with HKDF, so a
 * database export alone can't reveal them. Rotating SESSION_SECRET makes stored
 * values unreadable; they then have to be entered again.
 *
 * Format: "v1.<iv base64>.<ciphertext base64>" (AES-256-GCM, 96-bit random IV).
 */
const enc = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

function boxKey(sessionSecret: string, purpose: string): Promise<CryptoKey> {
  const id = `${purpose}\u0000${sessionSecret}`;
  let key = keys.get(id);
  if (!key) {
    key = crypto.subtle
      .importKey("raw", enc.encode(sessionSecret), "HKDF", false, ["deriveKey"])
      .then((ikm) =>
        crypto.subtle.deriveKey(
          { name: "HKDF", hash: "SHA-256", salt: enc.encode("inboxos/secret-box/v1"), info: enc.encode(purpose) },
          ikm,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        ),
      );
    keys.set(id, key);
  }
  return key;
}

/** Encrypt `plaintext`. `purpose` binds the value to one use (e.g. "resend.api_key"). */
export async function sealSecret(sessionSecret: string, purpose: string, plaintext: string): Promise<string> {
  if (!sessionSecret) throw new Error("SESSION_SECRET is not set");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await boxKey(sessionSecret, purpose), enc.encode(plaintext));
  return `v1.${b64encode(iv)}.${b64encode(new Uint8Array(ct))}`;
}

/** Decrypt a sealed value, or null when it's malformed, tampered with, or sealed under another key/purpose. */
export async function openSecret(sessionSecret: string, purpose: string, sealed: string | null | undefined): Promise<string | null> {
  if (!sealed || !sessionSecret) return null;
  const [v, iv, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !ct) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64decode(iv) as Uint8Array<ArrayBuffer> }, await boxKey(sessionSecret, purpose), b64decode(ct) as Uint8Array<ArrayBuffer>);
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

/** Show only the end of a credential, e.g. "re_••••••3f9a". */
export function maskSecret(value: string, visible = 4): string {
  if (value.length <= visible + 3) return "••••";
  const prefix = /^[a-z]+_/i.exec(value)?.[0] ?? "";
  return `${prefix}••••••${value.slice(-visible)}`;
}
