import { describe, expect, it } from "vitest";
import { isPushEndpoint, newMailPayload, vapidPublicKey } from "../worker/lib/push";
import { b64urlDecode, b64urlEncode, buildPushRequest, encryptPayload, vapidAuthorization } from "../worker/lib/webpush";

const b64url = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");
const fromB64url = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

async function vapidJwk() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const { kty, crv, x, y, d } = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { jwk: JSON.stringify({ kty, crv, x, y, d }), publicRaw: raw };
}

describe("push endpoints", () => {
  it("only delivers to real push services", () => {
    for (const ok of [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/QGd",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
    ])
      expect(isPushEndpoint(ok)).toBe(true);
    for (const bad of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://evil.example/fcm.googleapis.com",
      "https://fcm.googleapis.com.evil.example/x",
      "https://fcm.googleapis.com:8443/x",
      "https://169.254.169.254/latest",
      "not a url",
    ])
      expect(isPushEndpoint(bad)).toBe(false);
  });
});

describe("VAPID public key", () => {
  it("is derived from the private JWK, matching the real public key", async () => {
    const { jwk, publicRaw } = await vapidJwk();
    expect(vapidPublicKey(jwk)).toBe(b64url(publicRaw));
    expect(vapidPublicKey(undefined)).toBeNull();
    expect(vapidPublicKey("{}")).toBeNull();
  });
});

describe("lock-screen content", () => {
  const notice = { mailboxId: "mb1", message: { id: "m1", threadId: "t", from: { email: "priya@northwind.io", name: "Priya Shah" }, subject: "Website proposal", snippet: "secret body", date: "d" } };
  it("shows sender and subject, never the body", () => {
    const p = newMailPayload(notice, "Hello", true, 4);
    expect(p).toMatchObject({ title: "Priya Shah", body: "Website proposal", url: "/mail/mb1/inbox/m1", tag: "mail-mb1", badge: 4 });
    expect(JSON.stringify(p)).not.toContain("secret body");
  });
  it("hides details when the person asked", () => {
    const p = newMailPayload(notice, "Hello", false);
    expect(p.title).toBe("New mail in Hello");
    expect(JSON.stringify(p)).not.toMatch(/Priya|Website/);
  });
});

describe("end to end: a device can decrypt what we send (RFC 8291 aes128gcm)", () => {
  it("round-trips the payload and signs with our VAPID key", async () => {
    const { jwk, publicRaw } = await vapidJwk();
    // The "browser": its own ECDH key pair and auth secret, as a real subscription has.
    const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const uaPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey));
    const authSecret = crypto.getRandomValues(new Uint8Array(16));
    const payload = { title: "Priya Shah", body: "Website proposal", url: "/mail/mb1/inbox/m1", tag: "mail-mb1" };

    const req = await buildPushRequest({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys: { p256dh: b64url(uaPublic), auth: b64url(authSecret) },
      payload,
      privateJwk: JSON.parse(jwk),
      subject: "mailto:support@example.com",
      ttl: 60,
    });
    const headers = new Headers(req.headers);
    expect(headers.get("content-encoding")).toBe("aes128gcm");
    expect(headers.get("authorization")).toContain(`k=${b64url(publicRaw)}`);

    // Decrypt as the browser would.
    const body = new Uint8Array(req.body);
    const salt = body.slice(0, 16);
    const idLen = body[20]!;
    const asPublic = body.slice(21, 21 + idLen);
    const ciphertext = body.slice(21 + idLen);
    const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const ecdh = await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, ua.privateKey, 256);
    const hkdf = async (saltBytes: Uint8Array, ikm: ArrayBuffer | Uint8Array, info: Uint8Array, bytes: number) =>
      crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: saltBytes, info },
        await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]),
        bytes * 8,
      );
    const enc = new TextEncoder();
    const keyInfo = new Uint8Array([...enc.encode("WebPush: info\0"), ...uaPublic, ...asPublic]);
    const ikm = await hkdf(authSecret, ecdh, keyInfo, 32);
    const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
    const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
    const plain = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]), ciphertext),
    );
    // Strip the padding delimiter (0x02 for the last record) and any zero padding.
    let end = plain.length - 1;
    while (end > 0 && plain[end] === 0) end--;
    expect(plain[end]).toBe(2);
    expect(JSON.parse(new TextDecoder().decode(plain.slice(0, end)))).toEqual(payload);
  });
});

describe("RFC 8291 Appendix A test vector", () => {
  it("produces exactly the published message", async () => {
    const body = await encryptPayload(new TextEncoder().encode("When I grow up, I want to be a watermelon"), {
      p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      auth: "BTBZMqHH6r4Tts7J_aSIgg",
    }, {
      salt: b64urlDecode("DGv6ra1nlYgDCS1FRnbzlw"),
      asPrivate: b64urlDecode("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
      asPublic: b64urlDecode("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"),
    });
    expect(b64urlEncode(body)).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });
});

describe("VAPID token", () => {
  it("is a valid ES256 JWT for the push service's origin, under 24h", async () => {
    const { jwk } = await vapidJwk();
    const key = JSON.parse(jwk);
    const auth = await vapidAuthorization("https://web.push.apple.com/QGd/abc", key, "mailto:support@example.com", 1_700_000_000_000);
    const [, token, k] = auth.match(/^vapid t=([^,]+), k=(.+)$/)!;
    const [h, c, sig] = token!.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(Buffer.from(c!, "base64url").toString());
    expect(claims.aud).toBe("https://web.push.apple.com");
    expect(claims.exp - 1_700_000_000).toBeLessThanOrEqual(24 * 3600);
    const pub = await crypto.subtle.importKey("raw", fromB64url(k!), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, fromB64url(sig!), new TextEncoder().encode(`${h}.${c}`));
    expect(ok).toBe(true);
  });
});
