import { describe, expect, it } from "vitest";
import { autoReplyActive, DEFAULT_AUTOREPLY, normalizeBlockPattern, parseAutoReply, skipAutoReply } from "../worker/lib/mail-rules";

describe("auto-reply guards (RFC 3834)", () => {
  it("answers a normal person", () => {
    expect(skipAutoReply("jordan@brightside.co", {})).toBe(false);
  });
  it("never answers machines", () => {
    for (const from of ["no-reply@x.com", "noreply@x.com", "donotreply@x.com", "mailer-daemon@x.com", "notifications@github.com", "bounce+abc@x.com"]) {
      expect(skipAutoReply(from, {})).toBe(true);
    }
  });
  it("never answers lists, bulk mail or other auto-replies", () => {
    expect(skipAutoReply("a@x.com", { "auto-submitted": "auto-replied" })).toBe(true);
    expect(skipAutoReply("a@x.com", { "auto-submitted": "no" })).toBe(false);
    expect(skipAutoReply("a@x.com", { precedence: "bulk" })).toBe(true);
    expect(skipAutoReply("a@x.com", { "list-id": "<news.x.com>" })).toBe(true);
    expect(skipAutoReply("a@x.com", { "list-unsubscribe": "<https://x.com/u>" })).toBe(true);
    expect(skipAutoReply("a@x.com", { "x-auto-response-suppress": "OOF, AutoReply" })).toBe(true);
  });
});

describe("auto-reply window", () => {
  const on = { ...DEFAULT_AUTOREPLY, enabled: true, message: "Away" };
  it("needs to be enabled with a message", () => {
    expect(autoReplyActive(on)).toBe(true);
    expect(autoReplyActive({ ...on, enabled: false })).toBe(false);
    expect(autoReplyActive({ ...on, message: "  " })).toBe(false);
  });
  it("respects start and end", () => {
    const at = "2026-10-05T12:00:00.000Z";
    expect(autoReplyActive({ ...on, startsAt: "2026-10-06T00:00:00.000Z" }, at)).toBe(false);
    expect(autoReplyActive({ ...on, endsAt: "2026-10-05T00:00:00.000Z" }, at)).toBe(false);
    expect(autoReplyActive({ ...on, startsAt: "2026-10-01T00:00:00.000Z", endsAt: "2026-10-09T00:00:00.000Z" }, at)).toBe(true);
  });
  it("tolerates missing or broken stored settings", () => {
    expect(parseAutoReply(null)).toEqual(DEFAULT_AUTOREPLY);
    expect(parseAutoReply("not json")).toEqual(DEFAULT_AUTOREPLY);
  });
});

describe("block patterns", () => {
  it("accepts addresses and domains", () => {
    expect(normalizeBlockPattern(" Spam@Example.com ")).toBe("spam@example.com");
    expect(normalizeBlockPattern("@example.com")).toBe("@example.com");
    expect(normalizeBlockPattern("example.com")).toBe("@example.com");
  });
  it("rejects anything else", () => {
    expect(normalizeBlockPattern("")).toBeNull();
    expect(normalizeBlockPattern("%")).toBeNull();
    expect(normalizeBlockPattern("not an address")).toBeNull();
  });
});
