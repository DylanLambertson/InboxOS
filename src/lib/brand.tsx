import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { DEFAULT_BRAND, radiusValue, type Brand } from "@shared/brand";
import { api } from "./api";

const BrandContext = createContext<Brand>(DEFAULT_BRAND);
export const useBrand = () => useContext(BrandContext);

/** Pick black or white text for a given background color. */
export function readableOn(hex: string): string {
  const m = hex.replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return "#ffffff";
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.45 ? "#111111" : "#ffffff";
}

/** Apply brand tokens to the document (CSS variables, font, title, favicon). */
export function applyBrand(brand: Brand) {
  const root = document.documentElement.style;
  root.setProperty("--accent", brand.accentColor);
  root.setProperty("--accent-fg", readableOn(brand.accentColor));
  root.setProperty("--radius", radiusValue(brand.radius));
  root.setProperty("--font", brand.fontFamily);
  document.title = brand.productName;

  const fontId = "io-brand-font";
  document.getElementById(fontId)?.remove();
  if (brand.googleFont) {
    const link = document.createElement("link");
    link.id = fontId;
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(brand.googleFont)}:wght@400;500;600;700&display=swap`;
    document.head.appendChild(link);
  }

  let icon = document.querySelector<HTMLLinkElement>("link[rel='icon']");
  if (!icon) {
    icon = document.createElement("link");
    icon.rel = "icon";
    document.head.appendChild(icon);
  }
  icon.href = brand.logoUrl || monogramFavicon(brand);
}

function monogramFavicon(brand: Brand): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${brand.accentColor}"/><text x="32" y="41" font-family="system-ui,sans-serif" font-size="${brand.monogram.length > 2 ? 20 : 26}" font-weight="700" text-anchor="middle" fill="${readableOn(brand.accentColor)}">${brand.monogram.replace(/[<&>]/g, "")}</text></svg>`;
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

export function applyTheme(theme: "system" | "light" | "dark") {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}
