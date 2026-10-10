import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Inbox, PenSquare, Send, Star, Upload } from "lucide-react";
import { toast } from "sonner";
import type { Brand } from "@shared/brand";
import { contrastRatio } from "@shared/contrast";
import { resolvePalettes } from "@shared/theme";
import { api, errorMessage } from "@/lib/api";
import { applyThemeTokens, readableOn, useBrand } from "@/lib/brand";
import { useRefreshSetup } from "@/lib/setup";
import { Button, cx, Field, Input } from "@/components/ui/primitives";
import { Panel, StepFrame, type StepProps } from "../StepFrame";

const SWATCHES = ["#4f46e5", "#2563eb", "#0891b2", "#0f766e", "#16a34a", "#ca8a04", "#ea580c", "#dc2626", "#db2777", "#7c3aed", "#334155", "#18181b"];

/** Up to two initials, used when there's no logo. */
export const monogramFor = (name: string) =>
  (name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("") || "IO").toUpperCase().slice(0, 2);

/** A tiny, live picture of the app with the chosen name, logo and color. */
function MiniPreview({ productName, logoUrl, accent }: { productName: string; logoUrl: string; accent: string }) {
  const fg = readableOn(accent);
  const rows = [
    ["Priya Shah", "Website proposal", true],
    ["Jordan Lee", "Intro call next week?", true],
    ["Billing", "Your receipt #2041", false],
  ] as const;
  return (
    <div aria-hidden className="overflow-hidden rounded-ui-lg border border-line bg-bg shadow-ui-md">
      <div className="flex">
        <div className="w-36 shrink-0 space-y-1 border-r border-line bg-subtle p-2.5">
          <div className="mb-2.5 flex items-center gap-1.5">
            {logoUrl ? (
              <img src={logoUrl} alt="" className="size-5 rounded-ui-sm object-contain" />
            ) : (
              <span className="flex size-5 items-center justify-center rounded-ui-sm text-[8px] font-bold" style={{ background: accent, color: fg }}>
                {monogramFor(productName)}
              </span>
            )}
            <span className="truncate text-[11px] font-semibold text-fg">{productName || "Your app"}</span>
          </div>
          <div className="flex items-center justify-center gap-1 rounded-ui-sm py-1 text-[10px] font-medium" style={{ background: accent, color: fg }}>
            <PenSquare className="size-2.5" /> Compose
          </div>
          {[
            [Inbox, "Inbox", true],
            [Star, "Starred", false],
            [Send, "Sent", false],
          ].map(([Icon, label, active]) => {
            const I = Icon as typeof Inbox;
            return (
              <div key={label as string} className="flex items-center gap-1.5 rounded-ui-sm px-1.5 py-1 text-[10px]" style={active ? { background: `color-mix(in oklab, ${accent} 12%, transparent)`, color: accent } : undefined}>
                <I className="size-2.5" />
                <span className={active ? "font-medium" : "text-fg-muted"}>{label as string}</span>
              </div>
            );
          })}
        </div>
        <div className="min-w-0 flex-1 divide-y divide-line">
          {rows.map(([from, subject, unread]) => (
            <div key={from} className="flex items-start gap-1.5 px-3 py-2">
              <span className="mt-1 size-1.5 shrink-0 rounded-full" style={{ background: unread ? accent : "transparent" }} />
              <div className="min-w-0">
                <div className={cx("truncate text-[11px]", unread ? "font-semibold text-fg" : "text-fg-muted")}>{from}</div>
                <div className="truncate text-[10px] text-fg-muted">{subject}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Warn when the accent is hard to see as links and highlights on the page background. */
function AccentContrast({ accent }: { accent: string }) {
  const brand = useBrand();
  if (!/^#[0-9a-f]{6}$/i.test(accent)) return null;
  const { light, dark } = resolvePalettes(brand.theme);
  const weak = [
    contrastRatio(accent, light.bg) < 3 && "light",
    contrastRatio(accent, dark.bg) < 3 && "dark",
  ].filter(Boolean);
  if (!weak.length) return null;
  return (
    <p className="flex items-start gap-1.5 text-xs text-warning">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      This color is hard to read on {weak.join(" and ")} backgrounds. A deeper or brighter shade works better; Admin → Appearance can check every color pairing.
    </p>
  );
}

export function BrandStep({ setup, next, skip, back }: StepProps) {
  const brand = useBrand();
  const qc = useQueryClient();
  const refresh = useRefreshSetup();
  const [companyName, setCompanyName] = useState(brand.companyName);
  const [productName, setProductName] = useState(brand.productName);
  const [accent, setAccent] = useState(brand.theme.accent);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const saved = useRef(brand.theme);
  saved.current = brand.theme;

  // Live preview across the whole page; put the saved theme back if we leave without saving.
  useEffect(() => {
    if (/^#[0-9a-f]{6}$/i.test(accent)) applyThemeTokens({ ...saved.current, accent });
  }, [accent]);
  useEffect(() => () => applyThemeTokens(saved.current), []);

  const upload = async (f: File) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", f);
      const b = await api.post<Brand>("admin/settings/logo", form);
      qc.setQueryData(["brand"], b);
      toast.success("Logo uploaded");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      const product = productName.trim() || brand.productName;
      // The server merges partial theme updates over the saved theme.
      const body: Partial<Omit<Brand, "theme">> & { theme: { accent: string } } = { companyName: companyName.trim(), productName: product, theme: { accent } };
      // Keep the auto monogram in step with the name, unless someone already chose their own.
      if (brand.monogram === monogramFor(brand.productName) || brand.monogram === "IO") body.monogram = monogramFor(product);
      if (!brand.defaultFromName && companyName.trim()) body.defaultFromName = companyName.trim();
      const b = await api.put<Brand>("admin/settings/brand", body);
      saved.current = b.theme;
      qc.setQueryData(["brand"], b);
      await refresh();
      next();
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <StepFrame
      title="Make it yours"
      description="Your company name appears in emails and on the sign-in page. You can change it all later: identity in Admin → Branding, colors, fonts and dark mode in Admin → Appearance."
      onBack={back}
      onSkip={skip}
      onContinue={save}
      continueDisabled={!companyName.trim()}
      continueLoading={busy}
    >
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Panel>
          <div className="space-y-4">
            <Field label="Company name" htmlFor="b-company">
              <Input id="b-company" value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="Acme" autoFocus maxLength={120} />
            </Field>
            <Field label="App name" htmlFor="b-product" hint="What people call this inbox, e.g. Acme Mail.">
              <Input id="b-product" value={productName} onChange={(e) => setProductName(e.target.value)} maxLength={120} />
            </Field>
            <Field label="Logo" hint="A square PNG, SVG or JPG under 1 MB.">
              <div className="flex items-center gap-3">
                {brand.logoUrl ? (
                  <img src={brand.logoUrl} alt="Current logo" className="size-10 rounded-ui border border-line object-contain p-0.5" />
                ) : (
                  <span className="flex size-10 items-center justify-center rounded-ui text-sm font-bold" style={{ background: accent, color: readableOn(accent) }}>
                    {monogramFor(productName)}
                  </span>
                )}
                <Button size="sm" icon={<Upload className="size-4" />} loading={uploading} onClick={() => file.current?.click()}>
                  {brand.logoUrl ? "Replace" : "Upload"}
                </Button>
                <input
                  ref={file}
                  type="file"
                  hidden
                  accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void upload(f);
                    e.target.value = "";
                  }}
                />
              </div>
            </Field>
            <Field label="Accent color">
              <div className="flex flex-wrap items-center gap-2">
                {SWATCHES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`Use ${c}`}
                    aria-pressed={accent === c}
                    onClick={() => setAccent(c)}
                    className={cx("size-7 rounded-full ring-offset-2 ring-offset-surface transition-transform hover:scale-110", accent === c && "ring-2 ring-fg")}
                    style={{ background: c }}
                  />
                ))}
                <label className="flex h-7 items-center gap-1.5 rounded-full border border-line px-2">
                  <input type="color" value={accent} onChange={(e) => setAccent(e.target.value)} className="size-4 cursor-pointer border-0 bg-transparent p-0" aria-label="Custom color" />
                  <span className="font-mono text-[11px] text-fg-muted">{accent}</span>
                </label>
              </div>
            </Field>
          </div>
        </Panel>
        <div className="space-y-2">
          <p className="text-xs font-medium text-fg-muted">Preview</p>
          <MiniPreview productName={productName} logoUrl={brand.logoUrl} accent={accent} />
          <AccentContrast accent={accent} />
          <p className="text-xs text-fg-faint">
            {setup.steps.useCase === "done" ? "Spacing and corners come from your use case; " : ""}the color shows across this page as you pick it.
          </p>
        </div>
      </div>
    </StepFrame>
  );
}
