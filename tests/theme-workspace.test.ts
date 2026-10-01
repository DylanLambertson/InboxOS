import { describe, expect, it } from "vitest";
import { BASE_DARK, DEFAULT_THEME, resolvePalettes, sanitizeTheme } from "../shared/theme";
import { DEFAULT_WORKSPACE, FEATURE_KEYS, presetFeatures, sanitizeWorkspace, USE_CASE_PRESETS } from "../shared/workspace";
import { normalizeBrand } from "../worker/lib/settings";

describe("sanitizeTheme", () => {
  it("returns the defaults for garbage", () => {
    expect(sanitizeTheme(null)).toEqual(DEFAULT_THEME);
    expect(sanitizeTheme("nope")).toEqual(DEFAULT_THEME);
  });

  it("keeps valid tokens and drops invalid ones", () => {
    const t = sanitizeTheme({ accent: "#ABCDEF", radius: "xl", density: "dense", fontScale: 3, googleFont: "Bad;Font", extra: 1 });
    expect(t.accent).toBe("#abcdef");
    expect(t.radius).toBe("xl");
    expect(t.density).toBe(DEFAULT_THEME.density);
    expect(t.fontScale).toBe(1.15);
    expect(t.googleFont).toBe(DEFAULT_THEME.googleFont);
    expect(t).not.toHaveProperty("extra");
  });

  it("never lets CSS through a color or font", () => {
    const t = sanitizeTheme({ accent: "red;}</style>", fontFamily: "x;} body{display:none", light: { bg: "#fff;}", text: "#111111" } });
    expect(t.accent).toBe(DEFAULT_THEME.accent);
    expect(t.fontFamily).toBe(DEFAULT_THEME.fontFamily);
    expect(t.light).toEqual({ text: "#111111" });
  });

  it("merges a partial update over a base", () => {
    const base = sanitizeTheme({ accent: "#111111", radius: "lg", dark: { bg: "#000000" } });
    const next = sanitizeTheme({ radius: "sm" }, base);
    expect(next).toMatchObject({ accent: "#111111", radius: "sm", dark: { bg: "#000000" } });
  });

  it("resolves palettes over the built-in bases", () => {
    const { dark } = resolvePalettes(sanitizeTheme({ dark: { bg: "#010101" } }));
    expect(dark.bg).toBe("#010101");
    expect(dark.text).toBe(BASE_DARK.text);
  });
});

describe("normalizeBrand", () => {
  it("folds pre-theme brand fields into the theme", () => {
    const b = normalizeBrand({ productName: "Mailroom", accentColor: "#0f766e", radius: "lg", fontFamily: "Georgia, serif", googleFont: "" });
    expect(b.productName).toBe("Mailroom");
    expect(b.theme).toMatchObject({ accent: "#0f766e", radius: "lg", fontFamily: "Georgia, serif", googleFont: "" });
    expect(b).not.toHaveProperty("accentColor");
  });
});

describe("workspace presets", () => {
  it("every preset has a unique id and a valid theme", () => {
    expect(new Set(USE_CASE_PRESETS.map((p) => p.id)).size).toBe(USE_CASE_PRESETS.length);
    for (const p of USE_CASE_PRESETS) expect(sanitizeTheme(p.theme)).toMatchObject(p.theme);
  });

  it("presets start from everything on", () => {
    expect(Object.values(presetFeatures("enterprise")).every(Boolean)).toBe(true);
    const personal = presetFeatures("personal");
    expect(personal.compliance).toBe(false);
    expect(personal.templates).toBe(true);
    expect(Object.keys(personal).sort()).toEqual([...FEATURE_KEYS].sort());
  });

  it("sanitizes stored workspaces", () => {
    expect(sanitizeWorkspace(undefined)).toEqual(DEFAULT_WORKSPACE);
    const w = sanitizeWorkspace({ useCase: "support", features: { api: false, bogus: true, templates: "yes" } });
    expect(w.useCase).toBe("support");
    expect(w.features.api).toBe(false);
    expect(w.features.templates).toBe(DEFAULT_WORKSPACE.features.templates);
    expect(w.features).not.toHaveProperty("bogus");
    expect(sanitizeWorkspace({ useCase: "spaceship" }).useCase).toBe(DEFAULT_WORKSPACE.useCase);
  });
});
