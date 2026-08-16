import type { Address } from "@shared/types";

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** Compact date for message lists: 3:42 PM · Mar 4 · 3/4/24 */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (sameDay(d, now)) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return "Yesterday";
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: "short", day: "numeric" });
  return d.toLocaleDateString([], { year: "2-digit", month: "numeric", day: "numeric" });
}

export function longDate(iso: string): string {
  return new Date(iso).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function relativeTime(iso: string): string {
  const diff = (Date.now() - Date.parse(iso)) / 1000;
  const future = diff < 0;
  const s = Math.abs(diff);
  const fmt = (n: number, unit: string) => {
    const v = Math.round(n);
    const str = `${v} ${unit}${v === 1 ? "" : "s"}`;
    return future ? `in ${str}` : `${str} ago`;
  };
  if (s < 45) return future ? "in a moment" : "just now";
  if (s < 3600) return fmt(s / 60, "minute");
  if (s < 86_400) return fmt(s / 3600, "hour");
  if (s < 30 * 86_400) return fmt(s / 86_400, "day");
  return shortDate(iso);
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export const displayName = (a: Address | undefined | null) => (a ? a.name || a.email.split("@")[0] : "");
export const fullAddress = (a: Address) => (a.name ? `${a.name} <${a.email}>` : a.email);

export function initials(nameOrEmail: string): string {
  const clean = nameOrEmail.replace(/<.*>/, "").trim();
  const parts = clean.split(/[\s._@-]+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

/** Deterministic color from a string (for sender avatars). */
export function colorFor(s: string): string {
  const palette = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#64748b"];
  let h = 0;
  for (const ch of s.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
export const isEmail = (s: string) => EMAIL_RE.test(s.trim());

/** Parse `Name <a@b>` or `a@b`. */
export function parseAddress(raw: string): Address | null {
  const s = raw.trim().replace(/[,;]+$/, "");
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return isEmail(m[2]) ? { email: m[2].trim().toLowerCase(), name: m[1].trim() || undefined } : null;
  return isEmail(s) ? { email: s.toLowerCase() } : null;
}

export function parseUserAgent(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? (/iPhone|iPad/.test(ua) ? "iOS" : "macOS") : /Android/.test(ua) ? "Android" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}
