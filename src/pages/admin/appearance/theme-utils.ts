import type { CSSProperties } from "react";
import { readableOn } from "@shared/contrast";
import { BASE_DARK, BASE_LIGHT, densityScale, PALETTE_KEYS, radiusValue, resolvePalettes, SYSTEM_FONT_STACK, type Palette, type ThemeTokens } from "@shared/theme";
import { paletteVarName } from "@/lib/brand";

export type Mode = "light" | "dark";
export const BASES: Record<Mode, Palette> = { light: BASE_LIGHT, dark: BASE_DARK };

/**
 * CSS variables for a theme in one color mode, scoped to an element. Everything the app's
 * utility classes read is set here (including the derived soft accents, which index.css
 * computes at :root and so wouldn't follow a scoped --accent), so a preview never touches
 * the rest of the page.
 */
export function scopedThemeStyle(theme: ThemeTokens, mode: Mode): CSSProperties {
  const p = resolvePalettes(theme)[mode];
  const dark = mode === "dark";
  const vars: Record<string, string> = {
    "--accent": theme.accent,
    "--accent-fg": readableOn(theme.accent),
    "--accent-soft": `color-mix(in oklab, ${theme.accent} ${dark ? 20 : 10}%, transparent)`,
    "--accent-softer": `color-mix(in oklab, ${theme.accent} ${dark ? 11 : 6}%, transparent)`,
    "--danger-soft": `color-mix(in oklab, ${p.danger} 10%, transparent)`,
    "--success-soft": `color-mix(in oklab, ${p.success} 12%, transparent)`,
    "--warning-soft": `color-mix(in oklab, ${p.warning} 12%, transparent)`,
    "--radius": radiusValue(theme.radius),
    "--font": theme.fontFamily,
    "--font-scale": String(theme.fontScale),
    "--density": String(densityScale(theme.density)),
    "--shadow-sm": "0 1px 2px rgb(0 0 0 / 0.04)",
    "--shadow-md": dark ? "0 4px 16px -4px rgb(0 0 0 / 0.5)" : "0 4px 16px -4px rgb(0 0 0 / 0.08), 0 1px 3px rgb(0 0 0 / 0.04)",
    "--shadow-lg": dark ? "0 16px 48px -12px rgb(0 0 0 / 0.7)" : "0 16px 48px -12px rgb(0 0 0 / 0.18), 0 2px 6px rgb(0 0 0 / 0.05)",
  };
  for (const k of PALETTE_KEYS) vars[paletteVarName(k)] = p[k];
  return {
    ...(vars as CSSProperties),
    colorScheme: mode,
    background: p.bg,
    color: p.text,
    fontFamily: theme.fontFamily,
    fontSize: `calc(14px * ${theme.fontScale})`,
  };
}

// ---- Fonts -----------------------------------------------------------------------------------

export interface FontChoice {
  label: string;
  /** Google Fonts family to load ("" for the system font). */
  google: string;
  /** CSS font-family stack. */
  stack: string;
  /** Short description for the picker. */
  note: string;
}

const stackFor = (family: string) => `"${family}", ${SYSTEM_FONT_STACK}`;

export const FONT_CHOICES: FontChoice[] = [
  { label: "Inter", google: "Inter", stack: stackFor("Inter"), note: "Neutral and very legible (default)" },
  { label: "Geist", google: "Geist", stack: stackFor("Geist"), note: "Crisp, technical" },
  { label: "Manrope", google: "Manrope", stack: stackFor("Manrope"), note: "Modern, slightly rounded" },
  { label: "DM Sans", google: "DM Sans", stack: stackFor("DM Sans"), note: "Friendly geometric" },
  { label: "Plus Jakarta Sans", google: "Plus Jakarta Sans", stack: stackFor("Plus Jakarta Sans"), note: "Warm and polished" },
  { label: "IBM Plex Sans", google: "IBM Plex Sans", stack: stackFor("IBM Plex Sans"), note: "Corporate, precise" },
  { label: "Source Sans 3", google: "Source Sans 3", stack: stackFor("Source Sans 3"), note: "Classic UI workhorse" },
  { label: "Figtree", google: "Figtree", stack: stackFor("Figtree"), note: "Clean and approachable" },
  { label: "Atkinson Hyperlegible", google: "Atkinson Hyperlegible", stack: stackFor("Atkinson Hyperlegible"), note: "Designed for low vision" },
  { label: "System font", google: "", stack: SYSTEM_FONT_STACK, note: "Each device's own UI font, nothing to download" },
];

/** Load a Google font for previews without touching the app's own font link. */
export function ensurePreviewFont(family: string) {
  if (!family || !/^[A-Za-z0-9 ]+$/.test(family)) return;
  const id = `io-preview-font-${family.replace(/\s+/g, "-").toLowerCase()}`;
  if (document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@400;500;600;700&display=swap`;
  document.head.appendChild(link);
}

/** The CSS stack for a custom family name (quoted, with the system stack as fallback). */
export const customFontStack = (family: string) => stackFor(family.replace(/["\\;{}<>]/g, "").trim());

// ---- Differences -----------------------------------------------------------------------------

export interface ThemeChange {
  key: string;
  label: string;
  from: string;
  to: string;
  /** Hex values get a swatch. */
  color?: boolean;
}

const TOKEN_LABELS: Record<Exclude<keyof ThemeTokens, "light" | "dark">, string> = {
  accent: "Accent",
  radius: "Corners",
  density: "Density",
  fontFamily: "Font",
  googleFont: "Web font",
  fontScale: "Text size",
  defaultMode: "Default color mode",
};

export const PALETTE_LABELS: Record<keyof Palette, string> = {
  bg: "Background",
  bgSubtle: "Sidebar & subtle areas",
  bgMuted: "Hover & muted fills",
  surface: "Cards & panels",
  surfaceRaised: "Menus & dialogs",
  border: "Borders",
  borderStrong: "Strong borders",
  text: "Text",
  textMuted: "Secondary text",
  textFaint: "Faint text & placeholders",
  danger: "Danger",
  success: "Success",
  warning: "Warning",
};

/** Every visible difference between two themes, for the import review and the unsaved summary. */
export function themeDiff(a: ThemeTokens, b: ThemeTokens): ThemeChange[] {
  const out: ThemeChange[] = [];
  for (const k of Object.keys(TOKEN_LABELS) as (keyof typeof TOKEN_LABELS)[]) {
    if (a[k] !== b[k]) out.push({ key: k, label: TOKEN_LABELS[k], from: String(a[k]), to: String(b[k]), color: k === "accent" });
  }
  const pa = resolvePalettes(a);
  const pb = resolvePalettes(b);
  for (const mode of ["light", "dark"] as const) {
    for (const k of PALETTE_KEYS) {
      if (pa[mode][k] !== pb[mode][k]) out.push({ key: `${mode}.${k}`, label: `${mode === "light" ? "Light" : "Dark"}: ${PALETTE_LABELS[k]}`, from: pa[mode][k], to: pb[mode][k], color: true });
    }
  }
  return out;
}

/** Export file format. */
export interface ThemeFile {
  kind: "inboxos-theme";
  version: 1;
  exportedAt: string;
  theme: ThemeTokens;
}

/** Accept our export format or a bare theme object. */
export function themeFromFile(json: unknown): unknown {
  if (json && typeof json === "object" && "theme" in json && (json as { kind?: unknown }).kind === "inboxos-theme") return (json as { theme: unknown }).theme;
  return json;
}
