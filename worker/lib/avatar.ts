import type { AvatarType } from "@shared/profile";

/**
 * The real image type of an upload, from its first bytes. Browsers and clients can claim any
 * Content-Type, so the stored type always comes from here. Returns null for anything that
 * isn't a PNG, JPEG, WebP or GIF (SVG is deliberately not accepted: it can carry script).
 */
export function sniffImageType(head: Uint8Array): AvatarType | null {
  const at = (i: number) => head[i];
  const ascii = (from: number, s: string) => [...s].every((ch, i) => at(from + i) === ch.charCodeAt(0));
  if (head.length >= 8 && at(0) === 0x89 && ascii(1, "PNG") && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) return "image/png";
  if (head.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (head.length >= 6 && (ascii(0, "GIF87a") || ascii(0, "GIF89a"))) return "image/gif";
  if (head.length >= 12 && ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  return null;
}

/** A fresh, unguessable storage key for a user's avatar. */
export function newAvatarKey(userId: string): string {
  const rand = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `avatars/${userId}/${rand}`;
}

/** Only keys we wrote for this user are ever read or deleted. */
export const isAvatarKeyFor = (userId: string, key: string | null | undefined): key is string =>
  !!key && key.startsWith(`avatars/${userId}/`) && /^[0-9a-f]{24}$/.test(key.slice(`avatars/${userId}/`.length));
