import { describe, expect, it } from "vitest";
import { highlightRanges, jumpGroup, matchWord, moveIndex, parseRecent, pushRecent, rankEntries, scoreEntry, type PaletteEntry } from "../src/lib/palette-match";

const e = (id: string, title: string, group = "Admin", extra: Partial<PaletteEntry> = {}): PaletteEntry => ({ id, title, group, ...extra });

describe("matchWord", () => {
  it("prefers a match at the start of the text, then at a word start", () => {
    const start = matchWord("del", "Delivery log")!.score;
    const word = matchWord("log", "Delivery log")!.score;
    const middle = matchWord("liv", "Delivery log")!.score;
    expect(start).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(middle);
  });

  it("matches letters in order when there's no substring", () => {
    const m = matchWord("dlog", "Delivery log");
    expect(m).not.toBeNull();
    expect(m!.indices).toEqual([0, 9, 10, 11]);
    expect(m!.score).toBeLessThan(matchWord("deli", "Delivery log")!.score);
  });

  it("rejects letters out of order, missing letters and very scattered matches", () => {
    expect(matchWord("gol", "Delivery log")).toBeNull();
    expect(matchWord("xyz", "Delivery log")).toBeNull();
    expect(matchWord("ey", "Delivery log")).toBeNull();
  });

  it("ignores case and accents", () => {
    expect(matchWord("cafe", "Café notes")).not.toBeNull();
    expect(matchWord("users", "USERS")!.indices).toEqual([0, 1, 2, 3, 4]);
  });

  it("can refuse scattered matches (used for subtitles)", () => {
    expect(matchWord("dlog", "Delivery log", false)).toBeNull();
  });
});

describe("scoreEntry", () => {
  it("requires every word to match somewhere", () => {
    const entry = e("a", "Audit log", "Admin", { keywords: ["history"], subtitle: "Security & compliance" });
    expect(scoreEntry(entry, "audit history")).not.toBeNull();
    expect(scoreEntry(entry, "audit nope")).toBeNull();
    expect(scoreEntry(entry, "security")).not.toBeNull();
  });

  it("weights titles above keywords above subtitles", () => {
    const title = scoreEntry(e("a", "Domains"), "domains")!;
    const keyword = scoreEntry(e("b", "Mail setup", "Admin", { keywords: ["domains"] }), "domains")!;
    const subtitle = scoreEntry(e("c", "Something", "Admin", { subtitle: "domains" }), "domains")!;
    expect(title).toBeGreaterThan(keyword);
    expect(keyword).toBeGreaterThan(subtitle);
  });

  it("scores an empty query as zero", () => {
    expect(scoreEntry(e("a", "Users"), "  ")).toBe(0);
  });
});

describe("rankEntries", () => {
  const entries = [
    e("nav:users", "Users", "Admin"),
    e("act:invite", "Invite user", "Actions", { keywords: ["add person"] }),
    e("nav:audit", "Audit log", "Admin"),
    e("set:security", "Security", "Settings"),
    e("nav:security", "Security", "Admin"),
  ];

  it("orders groups by their best match and drops non-matches", () => {
    const r = rankEntries(entries, "user");
    expect(r[0]).toEqual({ group: "Admin", items: [entries[0]] });
    expect(r[1].items.map((i) => i.id)).toEqual(["act:invite"]);
    expect(r.flatMap((g) => g.items).some((i) => i.id === "nav:audit")).toBe(false);
  });

  it("boosts recently used entries", () => {
    const plain = rankEntries(entries, "security");
    expect(plain[0].group).toBe("Settings");
    const withRecent = rankEntries(entries, "security", { recent: ["nav:security"] });
    expect(withRecent[0].items[0].id).toBe("nav:security");
  });

  it("limits each group", () => {
    const many = Array.from({ length: 10 }, (_, i) => e(`x${i}`, `Mailbox ${i}`, "Mail"));
    expect(rankEntries(many, "mailbox", { limitPerGroup: 4 })[0].items).toHaveLength(4);
  });
});

describe("highlightRanges", () => {
  it("merges adjacent characters into ranges", () => {
    expect(highlightRanges("Delivery log", "del")).toEqual([[0, 3]]);
    expect(highlightRanges("Delivery log", "dlog")).toEqual([[0, 1], [9, 12]]);
    expect(highlightRanges("Delivery log", "")).toEqual([]);
  });
});

describe("recents", () => {
  it("keeps the newest first without duplicates", () => {
    const a = { id: "a", title: "A" };
    const b = { id: "b", title: "B" };
    expect(pushRecent([a, b], b)).toEqual([b, a]);
    expect(pushRecent([a, b], { id: "c", title: "C" }, 2).map((x) => x.id)).toEqual(["c", "a"]);
  });

  it("parses stored values defensively", () => {
    expect(parseRecent(null)).toEqual([]);
    expect(parseRecent("not json")).toEqual([]);
    expect(parseRecent('{"id":"a"}')).toEqual([]);
    expect(parseRecent('[{"id":"a","title":"A"},{"id":3},null]')).toEqual([{ id: "a", title: "A" }]);
  });
});

describe("keyboard movement", () => {
  it("wraps arrow movement", () => {
    expect(moveIndex(0, -1, 5)).toBe(4);
    expect(moveIndex(4, 1, 5)).toBe(0);
    expect(moveIndex(0, 1, 0)).toBe(-1);
  });

  it("jumps between group starts with Tab", () => {
    const sizes = [3, 2, 4];
    expect(jumpGroup(0, sizes, 1)).toBe(3);
    expect(jumpGroup(4, sizes, 1)).toBe(5);
    expect(jumpGroup(6, sizes, 1)).toBe(0);
    expect(jumpGroup(1, sizes, -1)).toBe(5);
    expect(jumpGroup(0, [0, 2], 1)).toBe(0);
  });
});
