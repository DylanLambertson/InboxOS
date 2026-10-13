import { describe, expect, it } from "vitest";
import { accentInk, contrastLevel, contrastProblems, contrastRatio, hexToRgb, paletteContrastChecks, readableOn, relativeLuminance } from "../shared/contrast";
import { BASE_DARK, BASE_LIGHT, DEFAULT_THEME } from "../shared/theme";
import { USE_CASE_PRESETS } from "../shared/workspace";

const USE_CASE_PRESETS_FOR_TESTS = USE_CASE_PRESETS.map((p) => p.theme.accent ?? DEFAULT_THEME.accent);

describe("contrast math", () => {
  it("parses hex colors", () => {
    expect(hexToRgb("#ff8000")).toEqual([255, 128, 0]);
    expect(hexToRgb("abc")).toEqual([170, 187, 204]);
    expect(hexToRgb("#12345")).toBeNull();
    expect(hexToRgb("red")).toBeNull();
  });

  it("computes WCAG relative luminance", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
    expect(relativeLuminance("#808080")).toBeCloseTo(0.2159, 3);
  });

  it("matches known contrast ratios", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBe(1);
    // Order doesn't matter.
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(contrastRatio("#ffffff", "#767676"), 10);
    // #767676 on white is the classic "just passes AA" gray.
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
  });

  it("rates ratios", () => {
    expect(contrastLevel(7.1)).toBe("AAA");
    expect(contrastLevel(4.5)).toBe("AA");
    expect(contrastLevel(3.2)).toBe("AA Large");
    expect(contrastLevel(2.9)).toBe("Fail");
  });

  it("picks dark text on light accents and white on dark ones", () => {
    expect(readableOn("#fde047")).toBe("#111111");
    expect(readableOn("#4f46e5")).toBe("#ffffff");
    expect(readableOn("nonsense")).toBe("#ffffff");
  });
});

describe("palette checks", () => {
  it("passes the built-in palettes with the default accent", () => {
    expect(contrastProblems(BASE_LIGHT, DEFAULT_THEME.accent)).toEqual([]);
    expect(contrastProblems(BASE_DARK, DEFAULT_THEME.accent)).toEqual([]);
  });

  it("passes every use-case preset accent", () => {
    for (const accent of USE_CASE_PRESETS_FOR_TESTS) expect(contrastProblems(BASE_LIGHT, accent).map((p) => p.id)).toEqual([]);
  });

  it("flags low-contrast text", () => {
    const ids = contrastProblems({ ...BASE_LIGHT, textMuted: "#c0c0c0" }, DEFAULT_THEME.accent).map((p) => p.id);
    expect(ids).toEqual(["textMuted/bg", "textMuted/surface"]);
  });

  it("checks the accent button label", () => {
    const check = paletteContrastChecks(BASE_LIGHT, "#a3a3a3").find((c) => c.id === "accentFg/accent")!;
    expect(check.fg).toBe(readableOn("#a3a3a3"));
    expect(check.min).toBe(3);
    expect(check.ratio).toBeGreaterThan(0);
  });
});

describe("accentInk", () => {
  it("keeps an accent that is already legible on the background", () => {
    expect(accentInk("#4f46e5", "#ffffff")).toBe("#4f46e5");
    expect(accentInk("#c6f135", "#0e0e10")).toBe("#c6f135");
  });

  it("darkens a bright accent on light backgrounds and lightens a dark one on dark backgrounds", () => {
    const onWhite = accentInk("#c6f135", "#ffffff");
    expect(contrastRatio(onWhite, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    const onBlack = accentInk("#1e1b4b", "#0e0e10");
    expect(contrastRatio(onBlack, "#0e0e10")).toBeGreaterThanOrEqual(4.5);
  });

  it("passes invalid colors through", () => {
    expect(accentInk("nope", "#ffffff")).toBe("nope");
  });
});
