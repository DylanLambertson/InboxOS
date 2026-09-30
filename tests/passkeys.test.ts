import { describe, expect, it } from "vitest";
import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import {
  CHALLENGE_TTL_MS,
  b64urlToBytes,
  challengeExpiry,
  challengeProblem,
  cleanPasskeyName,
  consumeChallenge,
  counterOk,
  defaultPasskeyName,
  isRecentAuth,
  needsPasskeySignIn,
  parseTransports,
  passkeyHosts,
  relyingParty,
  userHandleFor,
  type ChallengeRow,
} from "../worker/lib/passkeys";

const HOSTS = passkeyHosts("https://mail.example.com", ["example.com", "Example.org"]);

describe("relying party per host", () => {
  it("lists mail.<domain> for every mail domain plus the APP_URL host", () => {
    expect(HOSTS.sort()).toEqual(["mail.example.com", "mail.example.org"]);
    expect(passkeyHosts("https://inboxos.workers.dev", ["example.org"])).toEqual(["mail.example.org", "inboxos.workers.dev"]);
  });

  it("binds each app host to its own RP ID and origin", () => {
    expect(relyingParty("https://mail.example.com/api/auth/passkey/options", HOSTS)).toEqual({
      rpId: "mail.example.com",
      origin: "https://mail.example.com",
    });
    expect(relyingParty("https://mail.example.org/api/me/passkeys", HOSTS)).toEqual({ rpId: "mail.example.org", origin: "https://mail.example.org" });
  });

  it("refuses other hosts, lookalikes and plain http", () => {
    for (const bad of [
      "http://mail.example.org/x",
      "https://example.org/x",
      "https://evil.mail.example.org/x",
      "https://mail.example.org.evil.com/x",
      "https://attacker.example/x",
      "not a url",
    ]) {
      expect(relyingParty(bad, HOSTS)).toBeNull();
    }
  });

  it("works on localhost for development, port included in the origin", () => {
    expect(relyingParty("http://localhost:5173/api/auth/passkey/options", HOSTS)).toEqual({ rpId: "localhost", origin: "http://localhost:5173" });
    expect(relyingParty("http://127.0.0.1:5173/x", HOSTS)).toBeNull();
  });
});

describe("challenges", () => {
  const t0 = Date.parse("2026-10-01T12:00:00Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const row = (over: Partial<ChallengeRow> = {}): ChallengeRow => ({
    id: "h1",
    user_id: null,
    kind: "login",
    challenge: "abc",
    rp_id: "mail.example.org",
    expires_at: challengeExpiry(t0),
    ...over,
  });
  /** In-memory stand-in for DELETE … RETURNING. */
  const store = (rows: ChallengeRow[]) => {
    const m = new Map(rows.map((r) => [r.id, r]));
    return async (id: string) => {
      const r = m.get(id) ?? null;
      m.delete(id);
      return r;
    };
  };

  it("expire after five minutes", () => {
    expect(CHALLENGE_TTL_MS).toBe(300_000);
    const want = { kind: "login" as const, rpId: "mail.example.org" };
    expect(challengeProblem(row(), want, iso(t0 + 299_000))).toBeNull();
    expect(challengeProblem(row(), want, iso(t0 + 300_000))).toBe("expired");
    expect(challengeProblem(row(), want, iso(t0 + 3_600_000))).toBe("expired");
  });

  it("must match the ceremony, host and user", () => {
    const at = iso(t0);
    expect(challengeProblem(null, { kind: "login", rpId: "mail.example.org" }, at)).toBe("missing");
    expect(challengeProblem(row(), { kind: "register", rpId: "mail.example.org", userId: null }, at)).toBe("wrong_kind");
    expect(challengeProblem(row(), { kind: "login", rpId: "mail.example.com" }, at)).toBe("wrong_host");
    const reg = row({ kind: "register", user_id: "u1" });
    expect(challengeProblem(reg, { kind: "register", rpId: "mail.example.org", userId: "u2" }, at)).toBe("wrong_user");
    expect(challengeProblem(reg, { kind: "register", rpId: "mail.example.org", userId: "u1" }, at)).toBeNull();
  });

  it("work exactly once, even when the first use fails its checks", async () => {
    const take = store([row(), row({ id: "h2" })]);
    const want = { kind: "login" as const, rpId: "mail.example.org" };
    const first = await consumeChallenge(take, "h1", want, iso(t0));
    expect(first.ok && first.row.challenge).toBe("abc");
    expect(await consumeChallenge(take, "h1", want, iso(t0))).toEqual({ ok: false, reason: "missing" });

    // Wrong host burns the challenge too, so it can't be retried on the right one.
    expect(await consumeChallenge(take, "h2", { ...want, rpId: "mail.example.com" }, iso(t0))).toEqual({ ok: false, reason: "wrong_host" });
    expect(await consumeChallenge(take, "h2", want, iso(t0))).toEqual({ ok: false, reason: "missing" });
    expect(await consumeChallenge(take, null, want, iso(t0))).toEqual({ ok: false, reason: "missing" });
  });
});

describe("rules", () => {
  it("counters must move forward once they're in use", () => {
    expect(counterOk(0, 0)).toBe(true);
    expect(counterOk(0, 1)).toBe(true);
    expect(counterOk(5, 6)).toBe(true);
    expect(counterOk(5, 5)).toBe(false);
    expect(counterOk(5, 2)).toBe(false);
    expect(counterOk(5, 0)).toBe(false);
  });

  it("recent auth means a session younger than ten minutes", () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    expect(isRecentAuth("2026-10-01T11:55:00Z", now)).toBe(true);
    expect(isRecentAuth("2026-10-01T11:50:00Z", now)).toBe(false);
    expect(isRecentAuth("2026-10-01T12:05:00Z", now)).toBe(false);
    expect(isRecentAuth(null, now)).toBe(false);
    expect(isRecentAuth("garbage", now)).toBe(false);
  });

  it("with required 2FA, passkey-only users must sign in with the passkey", () => {
    expect(needsPasskeySignIn(true, false, 1)).toBe(true);
    expect(needsPasskeySignIn(true, true, 1)).toBe(false);
    expect(needsPasskeySignIn(false, false, 1)).toBe(false);
    expect(needsPasskeySignIn(true, false, 0)).toBe(false);
  });

  it("names, transports and user handles", () => {
    expect(cleanPasskeyName("  Work\u0000  MacBook‮ ")).toBe("Work MacBook");
    expect(cleanPasskeyName("x".repeat(100))).toHaveLength(60);
    expect(cleanPasskeyName("   ", "iPhone")).toBe("iPhone");
    expect(defaultPasskeyName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("iPhone");
    expect(defaultPasskeyName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("Mac");
    expect(defaultPasskeyName("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Windows PC");
    expect(defaultPasskeyName(null)).toBe("Passkey");
    expect(parseTransports('["internal","hybrid","bogus",1]')).toEqual(["internal", "hybrid"]);
    expect(parseTransports("nope")).toEqual([]);
    expect(new TextDecoder().decode(b64urlToBytes(userHandleFor("u_123-abc")))).toBe("u_123-abc");
  });
});

// ---- A software authenticator, to prove the library + our RP settings bind passkeys to one host ----

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b));
const utf8 = (s: string) => new TextEncoder().encode(s);
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};
const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

/** WebCrypto signs ECDSA as raw r||s; WebAuthn wants ASN.1 DER. */
function derSignature(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0] & 0x80) v = cat(new Uint8Array([0]), v);
    return cat(new Uint8Array([0x02, v.length]), v);
  };
  const body = cat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return cat(new Uint8Array([0x30, body.length]), body);
}

async function softAuthenticator(rpId: string, origin: string) {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const credId = crypto.getRandomValues(new Uint8Array(16));
  const cose = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, new Uint8Array(Buffer.from(jwk.x!, "base64url"))],
      [-3, new Uint8Array(Buffer.from(jwk.y!, "base64url"))],
    ]),
  );
  const UP = 0x01, UV = 0x04, AT = 0x40;

  return {
    async register(challenge: string, at = origin) {
      const authData = cat(await sha256(utf8(rpId)), new Uint8Array([UP | UV | AT]), u32(0), new Uint8Array(16), new Uint8Array([0, credId.length]), credId, cose);
      const att = isoCBOR.encode(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]) as never);
      return {
        id: b64u(credId),
        rawId: b64u(credId),
        type: "public-key" as const,
        response: { clientDataJSON: b64u(utf8(JSON.stringify({ type: "webauthn.create", challenge, origin: at, crossOrigin: false }))), attestationObject: b64u(att) },
        clientExtensionResults: {},
      };
    },
    async authenticate(challenge: string, counter: number, opts: { at?: string; uv?: boolean } = {}) {
      const authData = cat(await sha256(utf8(rpId)), new Uint8Array([UP | (opts.uv === false ? 0 : UV)]), u32(counter));
      const clientData = utf8(JSON.stringify({ type: "webauthn.get", challenge, origin: opts.at ?? origin, crossOrigin: false }));
      const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, cat(authData, await sha256(clientData))));
      return {
        id: b64u(credId),
        rawId: b64u(credId),
        type: "public-key" as const,
        response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(derSignature(raw)) },
        clientExtensionResults: {},
      };
    },
  };
}

describe("passkey ceremonies (software authenticator)", () => {
  const secondary = relyingParty("https://mail.example.org/", HOSTS)!;
  const primary = relyingParty("https://mail.example.com/", HOSTS)!;

  it("registers, signs in, and only works on the host it was made on", async () => {
    const auth = await softAuthenticator(secondary.rpId, secondary.origin);
    const regChallenge = b64u(crypto.getRandomValues(new Uint8Array(32)));
    const reg = await verifyRegistrationResponse({
      response: await auth.register(regChallenge),
      expectedChallenge: regChallenge,
      expectedOrigin: secondary.origin,
      expectedRPID: secondary.rpId,
      requireUserVerification: true,
      supportedAlgorithmIDs: [-7, -257],
    });
    expect(reg.verified).toBe(true);
    const credential = { ...reg.registrationInfo!.credential, counter: 0 };

    const challenge = b64u(crypto.getRandomValues(new Uint8Array(32)));
    const ok = await verifyAuthenticationResponse({
      response: await auth.authenticate(challenge, 1),
      expectedChallenge: challenge,
      expectedOrigin: secondary.origin,
      expectedRPID: secondary.rpId,
      credential,
      requireUserVerification: true,
    });
    expect(ok.verified && ok.authenticationInfo.userVerified).toBe(true);
    expect(ok.authenticationInfo.newCounter).toBe(1);

    // Same credential presented to the other app host: rejected.
    await expect(
      verifyAuthenticationResponse({
        response: await auth.authenticate(challenge, 2),
        expectedChallenge: challenge,
        expectedOrigin: primary.origin,
        expectedRPID: primary.rpId,
        credential,
        requireUserVerification: true,
      }),
    ).rejects.toThrow();
    // Wrong challenge, or no user verification: rejected.
    await expect(
      verifyAuthenticationResponse({ response: await auth.authenticate("other", 2), expectedChallenge: challenge, expectedOrigin: secondary.origin, expectedRPID: secondary.rpId, credential, requireUserVerification: true }),
    ).rejects.toThrow();
    await expect(
      verifyAuthenticationResponse({ response: await auth.authenticate(challenge, 2, { uv: false }), expectedChallenge: challenge, expectedOrigin: secondary.origin, expectedRPID: secondary.rpId, credential, requireUserVerification: true }),
    ).rejects.toThrow();
    // A counter that goes backwards: rejected.
    await expect(
      verifyAuthenticationResponse({ response: await auth.authenticate(challenge, 3), expectedChallenge: challenge, expectedOrigin: secondary.origin, expectedRPID: secondary.rpId, credential: { ...credential, counter: 7 }, requireUserVerification: true }),
    ).rejects.toThrow();
  });

  it("rejects a registration made for a different origin", async () => {
    const auth = await softAuthenticator(secondary.rpId, "https://evil.example");
    const challenge = b64u(crypto.getRandomValues(new Uint8Array(32)));
    await expect(
      verifyRegistrationResponse({ response: await auth.register(challenge), expectedChallenge: challenge, expectedOrigin: secondary.origin, expectedRPID: secondary.rpId, requireUserVerification: true }),
    ).rejects.toThrow();
  });
});
