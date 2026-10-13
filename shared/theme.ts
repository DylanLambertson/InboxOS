/**
 * THEME TOKENS
 *
 * The single source of truth for how the app looks. Every color, radius, font
 * and spacing value in the UI resolves from these tokens (see src/lib/brand.tsx,
 * which writes them to CSS variables, and src/index.css, which consumes them).
 * Use-case presets (shared/workspace.ts) start from a theme; admins can then edit
 * any token from Admin → Appearance or import/export the whole theme as JSON.
 */

export type Radius = "none" | "sm" | "md" | "lg" | "xl";
export type Density = "compact" | "comfortable" | "spacious";
export type ColorMode = "system" | "light" | "dark";

/** Neutral and status colors for one color mode. Accent is shared across modes. */
export interface Palette {
  bg: string;
  bgSubtle: string;
  bgMuted: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  textFaint: string;
  danger: string;
  success: string;
  warning: string;
}

export interface ThemeTokens {
  /** Brand accent (hex): buttons, focus rings, unread markers, links. */
  accent: string;
  /** Corner radius scale. */
  radius: Radius;
  /** Workspace default spacing; each person can still pick their own. */
  density: Density;
  /** CSS font-family stack for the UI. */
  fontFamily: string;
  /** Google Fonts family to load, e.g. "Inter". Empty = none. */
  googleFont: string;
  /** Multiplier for the base text size, 0.9–1.15. */
  fontScale: number;
  /** Color mode for people who haven't chosen one. */
  defaultMode: ColorMode;
  /** Overrides for the built-in light palette. Missing keys use BASE_LIGHT. */
  light: Partial<Palette>;
  /** Overrides for the built-in dark palette. Missing keys use BASE_DARK. */
  dark: Partial<Palette>;
}

export const PALETTE_KEYS = [
  "bg",
  "bgSubtle",
  "bgMuted",
  "surface",
  "surfaceRaised",
  "border",
  "borderStrong",
  "text",
  "textMuted",
  "textFaint",
  "danger",
  "success",
  "warning",
] as const satisfies readonly (keyof Palette)[];

export const BASE_LIGHT: Palette = {
  bg: "#ffffff",
  bgSubtle: "#f7f7f8",
  bgMuted: "#f0f0f2",
  surface: "#ffffff",
  surfaceRaised: "#ffffff",
  border: "#e6e6e9",
  borderStrong: "#d4d4d8",
  text: "#18181b",
  textMuted: "#6b6b76",
  textFaint: "#a1a1aa",
  danger: "#dc2626",
  success: "#16a34a",
  warning: "#d97706",
};

export const BASE_DARK: Palette = {
  bg: "#0e0e10",
  bgSubtle: "#141417",
  bgMuted: "#1c1c20",
  surface: "#141417",
  surfaceRaised: "#1b1b1f",
  border: "#26262b",
  borderStrong: "#34343a",
  text: "#ededf0",
  textMuted: "#9d9da8",
  textFaint: "#62626c",
  danger: "#dc2626",
  success: "#16a34a",
  warning: "#d97706",
};

export const SYSTEM_FONT_STACK = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export const DEFAULT_THEME: ThemeTokens = {
  accent: "#6210f8",
  radius: "md",
  density: "comfortable",
  fontFamily: `"Inter", ${SYSTEM_FONT_STACK}`,
  googleFont: "Inter",
  fontScale: 1,
  defaultMode: "system",
  light: {},
  dark: {},
};

/** Convert a radius keyword to a CSS length. */
export function radiusValue(r: Radius): string {
  return { none: "0px", sm: "6px", md: "10px", lg: "14px", xl: "20px" }[r] ?? "10px";
}

/** Vertical rhythm multiplier for a density. */
export function densityScale(d: Density): number {
  return { compact: 0.85, comfortable: 1, spacious: 1.15 }[d] ?? 1;
}

const HEX = /^#[0-9a-f]{6}$/i;
export const isHexColor = (v: unknown): v is string => typeof v === "string" && HEX.test(v);

function cleanPalette(input: unknown): Partial<Palette> {
  if (!input || typeof input !== "object") return {};
  const out: Partial<Palette> = {};
  for (const k of PALETTE_KEYS) {
    const v = (input as Record<string, unknown>)[k];
    if (isHexColor(v)) out[k] = v.toLowerCase();
  }
  return out;
}

/**
 * Coerce anything (a stored value, an imported JSON file, a partial update) into a
 * valid theme. Unknown keys are dropped and invalid values fall back to `base`, so a
 * bad import can never break the UI or inject CSS.
 */
export function sanitizeTheme(input: unknown, base: ThemeTokens = DEFAULT_THEME): ThemeTokens {
  const t = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const pick = <T,>(v: unknown, ok: (x: unknown) => x is T, fallback: T): T => (ok(v) ? v : fallback);
  const oneOf =
    <T extends string>(...opts: T[]) =>
    (x: unknown): x is T =>
      typeof x === "string" && (opts as string[]).includes(x);
  const font = (x: unknown): x is string => typeof x === "string" && x.trim().length > 0 && x.length <= 300 && !/[;{}<>]/.test(x);
  const gfont = (x: unknown): x is string => typeof x === "string" && x.length <= 60 && /^[A-Za-z0-9 ]*$/.test(x);
  const scale = typeof t.fontScale === "number" && Number.isFinite(t.fontScale) ? Math.min(1.15, Math.max(0.9, t.fontScale)) : base.fontScale;
  return {
    accent: isHexColor(t.accent) ? t.accent.toLowerCase() : base.accent,
    radius: pick(t.radius, oneOf<Radius>("none", "sm", "md", "lg", "xl"), base.radius),
    density: pick(t.density, oneOf<Density>("compact", "comfortable", "spacious"), base.density),
    fontFamily: pick(t.fontFamily, font, base.fontFamily),
    googleFont: pick(t.googleFont, gfont, base.googleFont),
    fontScale: Math.round(scale * 100) / 100,
    defaultMode: pick(t.defaultMode, oneOf<ColorMode>("system", "light", "dark"), base.defaultMode),
    light: "light" in t ? cleanPalette(t.light) : base.light,
    dark: "dark" in t ? cleanPalette(t.dark) : base.dark,
  };
}

/** Full palettes for a theme, with overrides applied over the built-in bases. */
export function resolvePalettes(theme: ThemeTokens): { light: Palette; dark: Palette } {
  return { light: { ...BASE_LIGHT, ...theme.light }, dark: { ...BASE_DARK, ...theme.dark } };
}
