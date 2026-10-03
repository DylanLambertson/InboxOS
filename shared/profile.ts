/**
 * PROFILES
 *
 * What teammates can learn about each other: a photo, title, department, pronouns,
 * where and when someone works. Limits and checks here are shared by the Worker
 * (which enforces them) and the web client (which mirrors them in the form).
 */

export const PROFILE_LIMITS = {
  bio: 280,
  pronouns: 40,
  department: 80,
  location: 80,
  website: 200,
  timezone: 64,
} as const;

/** Avatar uploads: formats we accept (checked by magic bytes, not the declared type) and size. */
export const AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type AvatarType = (typeof AVATAR_TYPES)[number];
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/** Editable profile fields (besides name, job title and phone, which predate profiles). */
export interface ProfileFields {
  bio: string;
  pronouns: string;
  department: string;
  location: string;
  /** IANA time zone, e.g. "Europe/Berlin". Empty = not set. */
  timezone: string;
  /** https:// URL. Empty = not set. */
  website: string;
}

/** A teammate as the directory shows them. */
export interface Teammate extends ProfileFields {
  id: string;
  name: string;
  email: string;
  color: string;
  avatarUrl: string | null;
  jobTitle: string;
  phone: string;
}

/** Whether a string names a time zone this runtime knows (IANA names like "America/New_York", or "UTC"). */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > PROFILE_LIMITS.timezone || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * A personal website as a normalized https URL, or null when it isn't one. A bare domain
 * ("example.com/me") gets https:// added; http:, javascript: and anything else are refused,
 * so a profile link can never downgrade to plain HTTP or run script.
 */
export function normalizeWebsite(input: string): string | null {
  const raw = input.trim();
  if (!raw || raw.length > PROFILE_LIMITS.website) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !url.hostname.includes(".") || url.username || url.password) return null;
  const out = url.toString();
  return out.length <= PROFILE_LIMITS.website ? out : null;
}

/**
 * Where a user's avatar is served. The random part of the storage key is in the URL, so a new
 * photo gets a new URL and the old one can be cached forever.
 */
export function avatarUrl(userId: string, avatarKey: string | null | undefined): string | null {
  if (!avatarKey) return null;
  const version = avatarKey.split("/").pop();
  return `/api/users/${encodeURIComponent(userId)}/avatar?v=${encodeURIComponent(version ?? "")}`;
}

/** The current time in a time zone, e.g. "3:42 PM", or "" when the zone is unknown. */
export function localTime(timezone: string, at: Date = new Date()): string {
  if (!isValidTimeZone(timezone)) return "";
  return at.toLocaleTimeString("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" });
}

/** "Europe/Berlin" → "Berlin", "America/Argentina/Buenos_Aires" → "Buenos Aires". */
export function timeZoneCity(timezone: string): string {
  return (timezone.split("/").pop() ?? timezone).replace(/_/g, " ");
}
