import type { OrgPolicy } from "@shared/brand";
import type { Role } from "@shared/types";
import { canViewConsole } from "./roles";

/**
 * IP allowlist matching. Every address is held as a 128-bit integer; IPv4 lives in the
 * IPv4-mapped range (::ffff:0:0/96) so "1.2.3.4" and "::ffff:1.2.3.4" are the same client
 * and an IPv4 CIDR never matches a native IPv6 address.
 */

const MAPPED_V4 = 0xffffn << 32n;
const ALL_ONES = (1n << 128n) - 1n;

function parseV4(s: string): bigint | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    // No leading zeros: "010" is octal to some parsers and decimal to others.
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8n) | BigInt(v);
  }
  return n;
}

function parseV6(s: string): bigint | null {
  if (!/^[0-9a-fA-F:.]+$/.test(s)) return null;
  let text = s;
  let tail: number[] = [];
  // Embedded IPv4 in the last 32 bits, e.g. ::ffff:1.2.3.4.
  const lastColon = text.lastIndexOf(":");
  if (text.includes(".")) {
    const v4 = parseV4(text.slice(lastColon + 1));
    if (v4 === null || lastColon < 0) return null;
    tail = [Number(v4 >> 16n), Number(v4 & 0xffffn)];
    text = text.slice(0, lastColon + 1);
    // "::1.2.3.4" leaves "::"; "a:b:c:d:e:f:1.2.3.4" leaves a trailing ":" to drop.
    if (!text.endsWith("::")) text = text.slice(0, -1);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (h: string) => (h === "" ? [] : h.split(":"));
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  if ([...head, ...rest].some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  const headWords = head.map((g) => parseInt(g, 16));
  // The embedded IPv4 always sits at the very end.
  const restWords = [...rest.map((g) => parseInt(g, 16)), ...tail];
  const missing = 8 - headWords.length - restWords.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...headWords, ...Array<number>(missing).fill(0), ...restWords];
  return all.reduce((n, w) => (n << 16n) | BigInt(w), 0n);
}

/** Parse an IPv4 or IPv6 address to a 128-bit integer (IPv4 as IPv4-mapped). Null if invalid. */
export function parseIp(input: string | null | undefined): bigint | null {
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (!s || s.length > 64) return null;
  if (s.includes(":")) return parseV6(s);
  const v4 = parseV4(s);
  return v4 === null ? null : MAPPED_V4 | v4;
}

export interface Cidr {
  base: bigint;
  /** Prefix length in the 128-bit space. */
  prefix: number;
}

/** Parse "10.0.0.0/8", "2001:db8::/32" or a bare address (a single host). Null if invalid. */
export function parseCidr(input: string | null | undefined): Cidr | null {
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (/\s/.test(s)) return null;
  const slash = s.indexOf("/");
  const addr = slash < 0 ? s : s.slice(0, slash);
  const v6 = addr.includes(":");
  const base = parseIp(addr);
  if (base === null) return null;
  const max = v6 ? 128 : 32;
  let len = max;
  if (slash >= 0) {
    const p = s.slice(slash + 1);
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return null;
    len = Number(p);
    if (len > max) return null;
    // "::ffff:10.0.0.0/8" is a /8 of the whole IPv6 space (every IPv4 client), not of 10.x.
    if (v6 && addr.includes(".") && len < 96) return null;
  }
  const prefix = v6 ? len : 96 + len;
  return { base: base & maskFor(prefix), prefix };
}

const maskFor = (prefix: number) => (prefix === 0 ? 0n : ALL_ONES ^ ((1n << BigInt(128 - prefix)) - 1n));

export const isValidCidr = (s: string) => parseCidr(s) !== null;

/** Whether `ip` falls inside `cidr`. Invalid input never matches. */
export function ipInCidr(ip: string | null | undefined, cidr: string): boolean {
  const n = parseIp(ip);
  const range = parseCidr(cidr);
  if (n === null || !range) return false;
  return (n & maskFor(range.prefix)) === range.base;
}

/** True when the list is empty (no restriction) or `ip` is inside any entry. */
export function ipAllowed(ip: string | null | undefined, list: readonly string[]): boolean {
  if (!list.length) return true;
  return list.some((cidr) => ipInCidr(ip, cidr));
}

/**
 * Whether the allowlist refuses this request. Pass no role before the account is known:
 * then only an "everyone" allowlist can refuse, so the answer can't reveal who is an admin.
 */
export function allowlistBlocks(policy: Pick<OrgPolicy, "ipAllowlist" | "ipAllowlistEnforceFor">, ip: string | null | undefined, role?: Role): boolean {
  const list = policy.ipAllowlist ?? [];
  if (!list.length) return false;
  if (policy.ipAllowlistEnforceFor === "admins") {
    if (!role || !canViewConsole(role)) return false;
  }
  return !ipAllowed(ip, list);
}

/** Saving an allowlist that excludes the admin saving it would lock them out on the next request. */
export function allowlistLockoutProblem(ip: string | null | undefined, list: readonly string[]): string | null {
  if (!list.length || ipAllowed(ip, list)) return null;
  return `Your current IP address (${ip || "unknown"}) isn't in this allowlist, so saving it would lock you out. Add your network first.`;
}

export const IP_BLOCKED_MESSAGE = "Access from your network isn't allowed by your organization's IP allowlist. Connect from an approved network or ask an administrator.";
