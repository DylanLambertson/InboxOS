/**
 * Passkey (WebAuthn) rules kept free of D1 and the WebAuthn library so they can be unit-tested:
 * which host a ceremony runs on, challenge validity, counters and re-authentication windows.
 */
import { b64url } from "./util";

/** Ceremony challenges live this long and work once. */
export const CHALLENGE_TTL_MS = 5 * 60_000;
/** Adding or removing a passkey without re-entering a password/code needs a session this fresh. */
export const RECENT_AUTH_MS = 10 * 60_000;
export const MAX_PASSKEYS = 20;
/** ES256 (every platform authenticator) and RS256 (Windows Hello, some security keys). */
export const PASSKEY_ALGORITHMS = [-7, -257];

const TRANSPORTS = ["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"] as const;
export type Transport = (typeof TRANSPORTS)[number];

export interface RelyingParty {
  /** WebAuthn RP ID: the bare host a passkey is bound to. */
  rpId: string;
  /** Exact origin the browser must report in clientDataJSON. */
  origin: string;
}

/** Hosts passkeys may be created and used on: mail.<each mail domain>, plus APP_URL's host. */
export function passkeyHosts(appUrl: string, mailDomains: string[]): string[] {
  const hosts = mailDomains.map((d) => `mail.${d.trim().toLowerCase()}`);
  try {
    hosts.push(new URL(appUrl).hostname.toLowerCase());
  } catch {
    // A malformed APP_URL just means no extra host.
  }
  return [...new Set(hosts)];
}

/**
 * The relying party for a request, or null when passkeys can't be used on this host.
 * The RP ID is the full host (not the registrable domain) so a passkey made on
 * mail.example.org never answers for mail.example.com or any sibling subdomain.
 */
export function relyingParty(requestUrl: string, hosts: string[]): RelyingParty | null {
  let u: URL;
  try {
    u = new URL(requestUrl);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  // Browsers treat http://localhost as a secure context, so local development works without TLS.
  if (host === "localhost") return { rpId: "localhost", origin: u.origin };
  if (u.protocol !== "https:" || !hosts.includes(host)) return null;
  return { rpId: host, origin: u.origin };
}

export type ChallengeKind = "register" | "login";

export interface ChallengeRow {
  id: string;
  user_id: string | null;
  kind: ChallengeKind;
  challenge: string;
  rp_id: string;
  expires_at: string;
}

export type ChallengeProblem = "missing" | "expired" | "wrong_kind" | "wrong_host" | "wrong_user";

/** Why a stored challenge can't be used for this ceremony, or null when it can. */
export function challengeProblem(
  row: ChallengeRow | null,
  want: { kind: ChallengeKind; rpId: string; userId?: string | null },
  nowIso: string,
): ChallengeProblem | null {
  if (!row) return "missing";
  if (row.expires_at <= nowIso) return "expired";
  if (row.kind !== want.kind) return "wrong_kind";
  if (row.rp_id !== want.rpId) return "wrong_host";
  if (want.kind === "register" && row.user_id !== (want.userId ?? null)) return "wrong_user";
  return null;
}

/**
 * Take a challenge out of storage and check it. `take` must remove the row as it reads it
 * (DELETE … RETURNING), so a challenge is consumed even when the check then fails: single use.
 */
export async function consumeChallenge(
  take: (id: string) => Promise<ChallengeRow | null>,
  id: string | null,
  want: { kind: ChallengeKind; rpId: string; userId?: string | null },
  nowIso: string,
): Promise<{ ok: true; row: ChallengeRow } | { ok: false; reason: ChallengeProblem }> {
  const row = id ? await take(id) : null;
  const reason = challengeProblem(row, want, nowIso);
  return reason ? { ok: false, reason } : { ok: true, row: row! };
}

export const challengeExpiry = (nowMs: number) => new Date(nowMs + CHALLENGE_TTL_MS).toISOString();

/**
 * Signature counters must move forward. Authenticators that don't count (most synced
 * passkeys) always report 0; once a credential has counted, a repeat or lower value
 * suggests a cloned authenticator.
 */
export const counterOk = (stored: number, received: number) => (stored === 0 && received === 0) || received > stored;

/** Session created (or re-verified) recently enough to manage passkeys without re-entering credentials. */
export function isRecentAuth(sessionCreatedAt: string | null | undefined, nowMs: number): boolean {
  if (!sessionCreatedAt) return false;
  const t = Date.parse(sessionCreatedAt);
  return Number.isFinite(t) && nowMs - t >= 0 && nowMs - t < RECENT_AUTH_MS;
}

/**
 * With an org-wide 2FA requirement, a user who relies on a passkey (no authenticator app)
 * must sign in with it: a password or Google alone would skip the second factor.
 */
export const needsPasskeySignIn = (require2fa: boolean, totpEnabled: boolean, passkeyCount: number) =>
  require2fa && !totpEnabled && passkeyCount > 0;

/** The WebAuthn user handle we register: the user id's UTF-8 bytes. */
export const userHandleBytes = (userId: string): Uint8Array<ArrayBuffer> => new Uint8Array(new TextEncoder().encode(userId));
export const userHandleFor = (userId: string) => b64url(userHandleBytes(userId));

export function parseTransports(json: string | null | undefined): Transport[] {
  try {
    const v: unknown = JSON.parse(json ?? "[]");
    return Array.isArray(v) ? (v.filter((t) => (TRANSPORTS as readonly unknown[]).includes(t)) as Transport[]) : [];
  } catch {
    return [];
  }
}

/** A tidy label: no control characters, single spaces, at most 60 characters. */
export function cleanPasskeyName(raw: string | null | undefined, fallback = "Passkey"): string {
  const s = (raw ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
  return s || fallback;
}

/** Suggested name from the device that's adding the passkey. */
export function defaultPasskeyName(ua: string | null | undefined): string {
  if (!ua) return "Passkey";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  if (/Mac OS X|Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/CrOS/.test(ua)) return "Chromebook";
  if (/Linux/.test(ua)) return "Linux computer";
  return "Passkey";
}

export const b64urlToBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
};
