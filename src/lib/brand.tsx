import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { DEFAULT_BRAND, type Brand } from "@shared/brand";
import { readableOn } from "@shared/contrast";
import { densityScale, PALETTE_KEYS, radiusValue, resolvePalettes, type Density, type Palette, type ThemeTokens } from "@shared/theme";
import type { DensityPreference, ThemePreference } from "@shared/types";
import { api } from "./api";

/** Pick black or white text for a given background color (shared with the contrast checks). */
export { readableOn };

const BrandContext = createContext<Brand>(DEFAULT_BRAND);
export const useBrand = () => useContext(BrandContext);

const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
/** CSS variable names in src/index.css that don't follow the palette key directly. */
const VAR_NAME: Partial<Record<keyof Palette, string>> = { text: "text", textMuted: "text-muted", textFaint: "text-faint" };
const paletteVars = (p: Palette) => PALETTE_KEYS.map((k) => `--${VAR_NAME[k] ?? kebab(k)}:${p[k]};`).join("");

/**
 * The CSS for a theme: palettes for both color modes (respecting an explicit
 * data-theme choice), plus the mode-independent tokens. Values come from
 * sanitizeTheme on the server, so they're always plain hex colors and lengths.
 */
export function themeCss(theme: ThemeTokens): string {
  const { light, dark } = resolvePalettes(theme);
  const shared = [
    `--accent:${theme.accent};`,
    `--accent-fg:${readableOn(theme.accent)};`,
    `--radius:${radiusValue(theme.radius)};`,
    `--font:${theme.fontFamily};`,
    `--font-scale:${theme.fontScale};`,
    `--density:${densityScale(theme.density)};`,
  ].join("");
  return [
    `:root{${shared}${paletteVars(light)}}`,
    `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${paletteVars(dark)}}}`,
    `:root[data-theme="dark"]{${paletteVars(dark)}}`,
    `:root[data-theme="light"]{${paletteVars(light)}}`,
  ].join("\n");
}

/** Write a theme to the document. Also used by the theme editor for live previews. */
export function applyThemeTokens(theme: ThemeTokens) {
  const id = "io-theme";
  let style = document.getElementById(id) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = id;
    document.head.appendChild(style);
  }
  style.textContent = themeCss(theme);

  const fontId = "io-brand-font";
  const existing = document.getElementById(fontId) as HTMLLinkElement | null;
  const href = theme.googleFont
    ? `https://fonts.googleapis.com/css2?family=${encodeURIComponent(theme.googleFont)}:wght@400;500;600;700&display=swap`
    : "";
  if (existing?.href === href) return;
  existing?.remove();
  if (href) {
    const link = document.createElement("link");
    link.id = fontId;
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
  }
}

/** Apply brand tokens to the document (theme, title, favicon). */
export function applyBrand(brand: Brand) {
  applyThemeTokens(brand.theme);
  document.title = brand.productName;

  let icon = document.querySelector<HTMLLinkElement>("link[rel='icon']");
  if (!icon) {
    icon = document.createElement("link");
    icon.rel = "icon";
    document.head.appendChild(icon);
  }
  icon.href = brand.logoUrl || monogramFavicon(brand);
}

function monogramFavicon(brand: Brand): string {
  const accent = brand.theme.accent;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${accent}"/><text x="32" y="41" font-family="system-ui,sans-serif" font-size="${brand.monogram.length > 2 ? 20 : 26}" font-weight="700" text-anchor="middle" fill="${readableOn(accent)}">${brand.monogram.replace(/[<&>]/g, "")}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function BrandProvider({ children }: { children: ReactNode }) {
  const { data } = useQuery({
    queryKey: ["brand"],
    queryFn: () => api.get<Brand>("/api/brand"),
    staleTime: 5 * 60_000,
    placeholderData: DEFAULT_BRAND,
  });
  const brand = data ?? DEFAULT_BRAND;
  useEffect(() => applyBrand(brand), [brand]);
  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>;
}

/** The color mode in effect: "workspace" uses the admin's default, which may itself be "system". */
export function effectiveMode(mode: ThemePreference, workspaceDefault: ThemeTokens["defaultMode"] = "system"): ThemeTokens["defaultMode"] {
  return mode === "workspace" ? workspaceDefault : mode;
}

/** Apply a person's color-mode choice. "system" follows the device; "workspace" the admin's default. */
export function applyTheme(mode: ThemePreference, workspaceDefault: ThemeTokens["defaultMode"] = "system") {
  const effective = effectiveMode(mode, workspaceDefault);
  if (effective === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = effective;
}

/** The spacing in effect for a person: their own choice, or the workspace default. */
export const effectiveDensity = (pref: DensityPreference | undefined, workspaceDefault: Density): Density =>
  !pref || pref === "workspace" ? workspaceDefault : pref;

/**
 * Apply a person's density over the workspace one: sets --density (which the theme
 * stylesheet otherwise takes from the workspace) and data-density for CSS that needs steps.
 */
export function applyDensity(pref: DensityPreference | undefined, workspaceDefault: Density) {
  const d = effectiveDensity(pref, workspaceDefault);
  const root = document.documentElement;
  root.dataset.density = d;
  if (!pref || pref === "workspace") root.style.removeProperty("--density");
  else root.style.setProperty("--density", String(densityScale(d)));
}

/** A person's effective density, for components (e.g. compact message rows). */
export function useDensity(pref: DensityPreference | undefined): Density {
  return effectiveDensity(pref, useBrand().theme.density);
}
