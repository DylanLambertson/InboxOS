/**
 * Web Push, the standard way, with WebCrypto only (runs on Workers):
 *  - RFC 8291 message encryption with the aes128gcm content coding (RFC 8188),
 *    which every push service accepts, Apple's included;
 *  - RFC 8292 VAPID: an ES256-signed JWT identifying this server.
 */

const enc = new TextEncoder();

export const b64urlEncode = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(new ArrayBuffer(parts.reduce((n, p) => n + p.length, 0)));
  let i = 0;
  for (const p of parts) (out.set(p, i), (i += p.length));
  return out;
};

async function hkdf(salt: Uint8Array, ikm: ArrayBuffer | Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource }, key, bytes * 8));
}

/** An ECDH P-256 private key from its raw scalar and public point (tests use fixed keys). */
async function importEcdhPrivate(d: Uint8Array, publicPoint: Uint8Array): Promise<CryptoKey> {
  const jwk = { kty: "EC", crv: "P-256", d: b64urlEncode(d), x: b64urlEncode(publicPoint.slice(1, 33)), y: b64urlEncode(publicPoint.slice(33, 65)), ext: true };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
}

/**
 * Encrypt a payload for one subscription (RFC 8291, single aes128gcm record).
 * `fixed` pins the salt and sender key, only for the RFC test vector.
 */
export async function encryptPayload(
  plaintext: Uint8Array,
  subscription: { p256dh: string; auth: string },
  fixed?: { salt: Uint8Array; asPrivate: Uint8Array; asPublic: Uint8Array },
): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = b64urlDecode(subscription.p256dh);
  const authSecret = b64urlDecode(subscription.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("Bad p256dh key");
  if (authSecret.length < 16) throw new Error("Bad auth secret");

  let asPrivate: CryptoKey;
  let asPublic: Uint8Array;
  if (fixed) {
    asPrivate = await importEcdhPrivate(fixed.asPrivate, fixed.asPublic);
    asPublic = fixed.asPublic;
  } else {
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    asPrivate = pair.privateKey;
    asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  }
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)));

  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  // The standard name is `public`; Cloudflare's type definitions spell it `$public`.
  const ecdhParams = { name: "ECDH", public: uaKey, $public: uaKey } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0];
  const ecdhSecret = await crypto.subtle.deriveBits(ecdhParams, asPrivate, 256);
  const ikm = await hkdf(authSecret, ecdhSecret, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  // One record: the plaintext plus the 0x02 "last record" delimiter.
  const record = concat(plaintext, new Uint8Array([2]));
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, record));

  // Header: salt (16) | record size (4, big-endian) | key id length (1) | key id (the sender's public key).
  const rs = 4096;
  const header = concat(salt, new Uint8Array([(rs >>> 24) & 255, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255, asPublic.length]), asPublic);
  return concat(header, ciphertext);
}

/** The VAPID Authorization header for one push service (RFC 8292). */
export async function vapidAuthorization(endpoint: string, privateJwk: JsonWebKey, subject: string, now = Date.now()): Promise<string> {
  const { kty, crv, x, y, d } = privateJwk;
  const key = await crypto.subtle.importKey("jwk", { kty, crv, x, y, d }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  // Push services refuse tokens valid for more than 24 hours.
  const claims = b64urlEncode(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  // WebCrypto's ECDSA signature is already the raw r||s form JWS wants.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`)));
  const publicKey = concat(new Uint8Array([4]), b64urlDecode(x!), b64urlDecode(y!));
  return `vapid t=${header}.${claims}.${b64urlEncode(sig)}, k=${b64urlEncode(publicKey)}`;
}

/** Everything needed to POST one push message. */
export async function buildPushRequest(opts: {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  payload: unknown;
  privateJwk: JsonWebKey;
  subject: string;
  ttl?: number;
  urgency?: "very-low" | "low" | "normal" | "high";
  topic?: string;
}): Promise<{ body: Uint8Array<ArrayBuffer>; headers: Record<string, string> }> {
  const body = await encryptPayload(enc.encode(JSON.stringify(opts.payload)), opts.keys);
  return {
    body,
    headers: {
      Authorization: await vapidAuthorization(opts.endpoint, opts.privateJwk, opts.subject),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(opts.ttl ?? 86_400),
      Urgency: opts.urgency ?? "normal",
      ...(opts.topic ? { Topic: opts.topic } : {}),
    },
  };
}
