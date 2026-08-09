import type { Address } from "@shared/types";

const enc = new TextEncoder();

export const now = () => new Date().toISOString();

/** URL-safe random id (default 16 bytes → 22 chars). */
export function newId(bytes = 16): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return b64url(b);
}

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64encode(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256hex(input: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
export const isEmail = (s: string) => EMAIL_RE.test(s.trim());

/** Parse `Name <a@b.c>` or `a@b.c`. */
export function parseAddress(raw: string): Address | null {
  const s = raw.trim();
  if (!s) return null;
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) {
    const email = m[2].trim().toLowerCase();
    return isEmail(email) ? { email, name: m[1].trim() || undefined } : null;
  }
  return isEmail(s) ? { email: s.toLowerCase() } : null;
}

/** Split a header list like `A <a@x>, "B, Jr" <b@x>` respecting quotes. */
export function parseAddressList(raw: string | string[] | null | undefined): Address[] {
  if (!raw) return [];
  const parts: string[] = [];
  for (const chunk of Array.isArray(raw) ? raw : [raw]) {
    let cur = "";
    let q = false;
    let angle = false;
    for (const ch of chunk) {
      if (ch === '"') q = !q;
      if (ch === "<") angle = true;
      if (ch === ">") angle = false;
      if (ch === "," && !q && !angle) {
        parts.push(cur);
        cur = "";
      } else cur += ch;
    }
    parts.push(cur);
  }
  return parts.map(parseAddress).filter((a): a is Address => a !== null);
}

export function formatAddress(a: Address): string {
  if (!a.name) return a.email;
  const needsQuote = /[",;<>@()]/.test(a.name);
  const name = needsQuote ? `"${a.name.replace(/"/g, '\\"')}"` : a.name;
  return `${name} <${a.email}>`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " ", apos: "'" };

/** Crude but dependency-free HTML → plain text for snippets, search and text/plain parts. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head|title)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, txt) =>
      txt.replace(/<[^>]+>/g, "").trim() === href ? href : `${txt} (${href})`,
    )
    .replace(/<[^>]+>/g, "")
    .replace(/&(#?\w+);/g, (m, e) => ENTITIES[e] ?? (e.startsWith("#") ? String.fromCharCode(parseInt(e.slice(1))) : m))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function textToHtml(text: string): string {
  return `<div style="white-space:pre-wrap">${escapeHtml(text)}</div>`;
}

export function makeSnippet(text: string, len = 180): string {
  const t = text
    .split("\n")
    .filter((l) => !l.startsWith(">"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > len ? t.slice(0, len - 1) + "…" : t;
}

/** Strip Re:/Fwd: prefixes to compare subjects across a thread. */
export function normalizeSubject(s: string): string {
  return s.replace(/^\s*((re|fw|fwd|aw|sv|wg)\s*(\[\d+\])?\s*:\s*)+/i, "").trim().toLowerCase();
}

export function domainOf(email: string): string {
  return email.split("@")[1]?.toLowerCase() ?? "";
}

export function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === "string" ? parseInt(v, 10) : typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[\\/\x00-\x1f"<>|:*?]/g, "_").trim();
  return cleaned.slice(0, 200) || "attachment";
}

export const AVATAR_COLORS = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6", "#64748b"];
export const randomColor = () => AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
