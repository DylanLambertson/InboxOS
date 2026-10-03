/**
 * COLOR CONTRAST (WCAG 2.x)
 *
 * Pure helpers used by the theme editor to warn when a palette makes text hard to
 * read, and by the app to pick black or white text on the accent color.
 * See https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio.
 */
import type { Palette } from "./theme";

const HEX6 = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const HEX3 = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i;

/** [r, g, b] in 0–255 for a #rgb or #rrggbb color, or null when it isn't one. */
export function hexToRgb(hex: string): [number, number, number] | null {
  const m = hex.trim().match(HEX6) ?? hex.trim().match(HEX3)?.map((x, i) => (i ? x + x : x));
  if (!m) return null;
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

/** WCAG relative luminance, 0 (black) to 1 (white). Invalid colors count as black. */
export function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio between two colors, from 1 (identical) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Black-ish or white text, whichever the app uses on a given background (e.g. the accent). */
export function readableOn(hex: string): string {
  if (!hexToRgb(hex)) return "#ffffff";
  return relativeLuminance(hex) > 0.45 ? "#111111" : "#ffffff";
}

export type ContrastLevel = "AAA" | "AA" | "AA Large" | "Fail";

/** WCAG rating for normal-size text at a given ratio. */
export function contrastLevel(ratio: number): ContrastLevel {
  if (ratio >= 7) return "AAA";
  if (ratio >= 4.5) return "AA";
  if (ratio >= 3) return "AA Large";
  return "Fail";
}

export interface ContrastCheck {
  /** Stable id, e.g. "text/bg". */
  id: string;
  /** Plain-language name of the pairing. */
  label: string;
  fg: string;
  bg: string;
  ratio: number;
  /** The ratio this pairing should reach. */
  min: number;
  ok: boolean;
}

/**
 * The pairings that matter for legibility in one color mode: body and secondary text on the
 * page and on cards, and the button label on the accent. Secondary text is held to the full
 * 4.5:1; the accent button label to 3:1 (it's short, medium-weight UI text).
 */
export function paletteContrastChecks(p: Palette, accent: string): ContrastCheck[] {
  const accentFg = readableOn(accent);
  const pairs: [id: string, label: string, fg: string, bg: string, min: number][] = [
    ["text/bg", "Text on background", p.text, p.bg, 4.5],
    ["text/surface", "Text on cards", p.text, p.surface, 4.5],
    ["textMuted/bg", "Secondary text on background", p.textMuted, p.bg, 4.5],
    ["textMuted/surface", "Secondary text on cards", p.textMuted, p.surface, 4.5],
    ["accentFg/accent", "Button label on accent", accentFg, accent, 3],
  ];
  return pairs.map(([id, label, fg, bg, min]) => {
    const ratio = Math.round(contrastRatio(fg, bg) * 100) / 100;
    return { id, label, fg, bg, ratio, min, ok: ratio >= min };
  });
}

/** Only the pairings that fall short. */
export const contrastProblems = (p: Palette, accent: string) => paletteContrastChecks(p, accent).filter((c) => !c.ok);
