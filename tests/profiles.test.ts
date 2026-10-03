import { describe, expect, it } from "vitest";
import { avatarUrl, isValidTimeZone, normalizeWebsite, timeZoneCity } from "../shared/profile";
import { DEFAULT_PREFERENCES, migratePreferences, PREFERENCES_VERSION } from "../shared/types";
import { isAvatarKeyFor, newAvatarKey, sniffImageType } from "../worker/lib/avatar";
import { zProfilePatch } from "../worker/lib/profile";

const bytes = (...xs: (number | string)[]) => new Uint8Array(xs.flatMap((x) => (typeof x === "string" ? [...x].map((c) => c.charCodeAt(0)) : [x])));

describe("avatar magic bytes", () => {
  it("recognizes PNG, JPEG, GIF and WebP", () => {
    expect(sniffImageType(bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0))).toBe("image/png");
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10))).toBe("image/jpeg");
    expect(sniffImageType(bytes("GIF89a", 1, 0))).toBe("image/gif");
    expect(sniffImageType(bytes("GIF87a"))).toBe("image/gif");
    expect(sniffImageType(bytes("RIFF", 0x24, 0, 0, 0, "WEBPVP8 "))).toBe("image/webp");
  });

  it("refuses SVG, HTML and anything else, whatever it claims to be", () => {
    expect(sniffImageType(bytes("<svg xmlns='http://www.w3.org/2000/svg'>"))).toBeNull();
    expect(sniffImageType(bytes("<!doctype html><script>"))).toBeNull();
    expect(sniffImageType(bytes("RIFF", 0, 0, 0, 0, "WAVEfmt "))).toBeNull();
    expect(sniffImageType(bytes(0x89, "PN"))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });

  it("makes unguessable keys scoped to the user", () => {
    const key = newAvatarKey("u1");
    expect(key).toMatch(/^avatars\/u1\/[0-9a-f]{24}$/);
    expect(newAvatarKey("u1")).not.toBe(key);
    expect(isAvatarKeyFor("u1", key)).toBe(true);
    expect(isAvatarKeyFor("u2", key)).toBe(false);
    expect(isAvatarKeyFor("u1", "brand/logo")).toBe(false);
    expect(isAvatarKeyFor("u1", "avatars/u1/../../brand/logo")).toBe(false);
    expect(isAvatarKeyFor("u1", null)).toBe(false);
  });

  it("puts the key's random part in the avatar URL", () => {
    expect(avatarUrl("u1", "avatars/u1/abc123")).toBe("/api/users/u1/avatar?v=abc123");
    expect(avatarUrl("u1", null)).toBeNull();
  });
});

describe("profile validation", () => {
  const parse = (v: unknown) => zProfilePatch.safeParse(v);

  it("accepts a full profile and trims it", () => {
    const r = parse({ pronouns: " she/her ", department: "Support", location: "Berlin", timezone: "Europe/Berlin", bio: "Hi!\nI answer support@.", website: "example.com/me" });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ pronouns: "she/her", timezone: "Europe/Berlin", website: "https://example.com/me" });
  });

  it("lets every field be cleared", () => {
    const r = parse({ pronouns: "", department: "", location: "", timezone: "", bio: "", website: "" });
    expect(r.success).toBe(true);
    expect(r.data?.website).toBe("");
  });

  it("enforces length limits", () => {
    expect(parse({ bio: "x".repeat(281) }).success).toBe(false);
    expect(parse({ pronouns: "x".repeat(41) }).success).toBe(false);
    expect(parse({ department: "x".repeat(81) }).success).toBe(false);
  });

  it("only accepts real IANA time zones", () => {
    expect(parse({ timezone: "America/New_York" }).success).toBe(true);
    expect(parse({ timezone: "UTC" }).success).toBe(true);
    expect(parse({ timezone: "Mars/Olympus_Mons" }).success).toBe(false);
    expect(parse({ timezone: "Europe/Berlin; DROP" }).success).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });

  it("only accepts https websites", () => {
    expect(parse({ website: "http://example.com" }).success).toBe(false);
    expect(parse({ website: "javascript:alert(1)" }).success).toBe(false);
    expect(parse({ website: "https://user:pw@example.com" }).success).toBe(false);
    expect(parse({ website: "localhost" }).success).toBe(false);
    expect(normalizeWebsite("HTTPS://Example.com")).toBe("https://example.com/");
  });

  it("keeps single-line fields on one line", () => {
    expect(parse({ department: "Sales\nTeam" }).success).toBe(false);
    expect(parse({ bio: "a\u0007b" }).success).toBe(false);
    expect(parse({ bio: "a\n\n\n\nb" }).data?.bio).toBe("a\n\nb");
  });

  it("names a city for a zone", () => {
    expect(timeZoneCity("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
  });
});

describe("preference migration", () => {
  it("fills in defaults for new people", () => {
    expect(migratePreferences({})).toEqual(DEFAULT_PREFERENCES);
    expect(migratePreferences(null)).toEqual(DEFAULT_PREFERENCES);
  });

  it("moves the old defaults to the workspace default once", () => {
    const p = migratePreferences({ theme: "system", density: "comfortable", undoSendSeconds: 10 });
    expect(p).toMatchObject({ theme: "workspace", density: "workspace", undoSendSeconds: 10, v: PREFERENCES_VERSION });
  });

  it("keeps deliberate choices", () => {
    expect(migratePreferences({ theme: "dark", density: "compact" })).toMatchObject({ theme: "dark", density: "compact" });
  });

  it("respects Match system once preferences are current", () => {
    expect(migratePreferences({ theme: "system", density: "comfortable", v: PREFERENCES_VERSION })).toMatchObject({ theme: "system", density: "comfortable" });
  });

  it("repairs unknown values", () => {
    expect(migratePreferences({ theme: "neon", density: 3, v: PREFERENCES_VERSION })).toMatchObject({ theme: "workspace", density: "workspace" });
  });
});
