import { INBOXOS_LOGO, type Brand } from "@shared/brand";
import { api } from "./api";
import { readableOn } from "./brand";

/**
 * Home-screen icons drawn from the brand (logo on the accent color, or the
 * monogram) in the admin's browser and uploaded, since the Worker can't
 * rasterize images. Run after the brand changes.
 */

const SPECS = [
  { name: "icon-192", size: 192, inset: 0.18 },
  { name: "icon-512", size: 512, inset: 0.18 },
  // Maskable icons get cropped to a circle or squircle: keep the mark in the middle 60%.
  { name: "maskable-512", size: 512, inset: 0.26 },
  { name: "apple-touch-icon", size: 180, inset: 0.16 },
] as const;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Logo could not be loaded"));
    img.src = src;
  });
}

async function draw(brand: Brand, logo: HTMLImageElement | null, size: number, inset: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = brand.theme.accent;
  ctx.fillRect(0, 0, size, size);
  const box = size * (1 - inset * 2);
  if (logo) {
    // The logo, centered and contained, on the accent color.
    const scale = Math.min(box / logo.naturalWidth, box / logo.naturalHeight);
    const w = logo.naturalWidth * scale;
    const h = logo.naturalHeight * scale;
    ctx.drawImage(logo, (size - w) / 2, (size - h) / 2, w, h);
  } else {
    ctx.fillStyle = readableOn(brand.theme.accent);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const letters = brand.monogram.slice(0, 3);
    ctx.font = `700 ${Math.round(box * (letters.length > 2 ? 0.42 : 0.52))}px -apple-system, system-ui, "Segoe UI", Roboto, sans-serif`;
    ctx.fillText(letters, size / 2, size / 2 + size * 0.02);
  }
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Icon render failed"))), "image/png"));
}

/** The bundled InboxOS icons (public/icons), already drawn for each size. */
async function stockIcon(name: string): Promise<Blob> {
  const res = await fetch(`/icons/${name}.png`);
  if (!res.ok) throw new Error("Icon could not be loaded");
  return res.blob();
}

export async function regenerateAppIcons(brand: Brand): Promise<void> {
  if (brand.logoUrl === INBOXOS_LOGO) {
    const form = new FormData();
    for (const spec of SPECS) form.append(spec.name, new File([await stockIcon(spec.name)], `${spec.name}.png`, { type: "image/png" }));
    await api.post("admin/settings/icons", form);
    return;
  }
  let logo: HTMLImageElement | null = null;
  if (brand.logoUrl) {
    try {
      logo = await loadImage(brand.logoUrl);
    } catch {
      logo = null; // fall back to the monogram
    }
  }
  const form = new FormData();
  for (const spec of SPECS) form.append(spec.name, new File([await draw(brand, logo, spec.size, spec.inset)], `${spec.name}.png`, { type: "image/png" }));
  await api.post("admin/settings/icons", form);
}
