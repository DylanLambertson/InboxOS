import { useEffect, useState } from "react";
import { AlertTriangle, Check } from "lucide-react";
import { contrastRatio, readableOn } from "@shared/contrast";
import { radiusValue, type ColorMode, type Density, type Radius, type ThemeTokens } from "@shared/theme";
import { cx, Input, Section, Select } from "@/components/ui/primitives";
import { ColorField, Segmented, SettingRow } from "./controls";
import { customFontStack, ensurePreviewFont, FONT_CHOICES } from "./theme-utils";

const ACCENTS = ["#6210f8", "#4f46e5", "#2563eb", "#0891b2", "#0f766e", "#059669", "#65a30d", "#d97706", "#ea580c", "#e11d48", "#db2777", "#9333ea", "#334155"];

const RADII: { value: Radius; label: string }[] = [
  { value: "none", label: "Square" },
  { value: "sm", label: "Subtle" },
  { value: "md", label: "Rounded" },
  { value: "lg", label: "Soft" },
  { value: "xl", label: "Round" },
];

export function TokenEditor({ theme, set }: { theme: ThemeTokens; set: (patch: Partial<ThemeTokens>) => void }) {
  const preset = FONT_CHOICES.find((f) => f.stack === theme.fontFamily);
  const [custom, setCustom] = useState(preset ? "" : (theme.googleFont || theme.fontFamily.match(/^"([^"]+)"/)?.[1] || ""));
  const [customGoogle, setCustomGoogle] = useState(preset ? true : !!theme.googleFont);
  useEffect(() => {
    // Load every curated font once so the picker can show each in its own face.
    FONT_CHOICES.forEach((f) => ensurePreviewFont(f.google));
  }, []);

  const labelRatio = contrastRatio(readableOn(theme.accent), theme.accent);
  const applyCustom = (family: string, google = customGoogle) => {
    const clean = family.replace(/[^A-Za-z0-9 ]/g, "").replace(/\s+/g, " ").slice(0, 60);
    setCustom(clean);
    if (!clean.trim()) return;
    if (google) ensurePreviewFont(clean.trim());
    set({ fontFamily: customFontStack(clean), googleFont: google ? clean.trim() : "" });
  };

  return (
    <Section title="Look" description="Accent, shape, spacing and type. Every change shows up in the preview straight away.">
      <div className="divide-y divide-line">
        <SettingRow
          title="Accent color"
          description={
            <span className="inline-flex items-center gap-1">
              Buttons, links, focus rings and unread markers.
              {labelRatio < 3 ? (
                <span className="inline-flex items-center gap-1 text-warning">
                  <AlertTriangle className="size-3" /> Button labels are hard to read on this color ({labelRatio.toFixed(1)}:1).
                </span>
              ) : null}
            </span>
          }
        >
          <div className="flex max-w-[22rem] flex-wrap items-center gap-1.5">
            {ACCENTS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Use ${c}`}
                aria-pressed={theme.accent === c}
                onClick={() => set({ accent: c })}
                className={cx("flex size-6 items-center justify-center rounded-full ring-offset-2 ring-offset-surface transition-transform hover:scale-110", theme.accent === c && "ring-2 ring-fg")}
                style={{ background: c }}
              >
                {theme.accent === c && <Check className="size-3.5" style={{ color: readableOn(c) }} />}
              </button>
            ))}
            <ColorField label="Accent" value={theme.accent} onChange={(accent) => set({ accent })} invalid={labelRatio < 3} />
          </div>
        </SettingRow>

        <SettingRow title="Corners" description="How rounded buttons, fields and cards are.">
          <div role="radiogroup" aria-label="Corners" className="flex gap-1.5">
            {RADII.map((r) => (
              <button
                key={r.value}
                type="button"
                role="radio"
                aria-checked={theme.radius === r.value}
                onClick={() => set({ radius: r.value })}
                className={cx(
                  "flex w-14 flex-col items-center gap-1 rounded-ui border px-1 py-1.5 text-[11px] font-medium transition-colors",
                  theme.radius === r.value ? "border-accent-ink bg-accent-softer text-accent-ink" : "border-line text-fg-muted hover:border-line-strong hover:text-fg",
                )}
              >
                <span className="size-5 border-2 border-current" style={{ borderRadius: radiusValue(r.value) === "0px" ? 0 : `calc(${radiusValue(r.value)} * 0.6)` }} />
                {r.label}
              </button>
            ))}
          </div>
        </SettingRow>

        <SettingRow title="Density" description="Workspace default spacing. People can still pick their own in Settings → Profile.">
          <Segmented<Density>
            label="Density"
            value={theme.density}
            onChange={(density) => set({ density })}
            options={[
              { value: "compact", label: "Compact", hint: "More messages on screen" },
              { value: "comfortable", label: "Comfortable" },
              { value: "spacious", label: "Spacious", hint: "More breathing room" },
            ]}
          />
        </SettingRow>

        <SettingRow title="Font" description={preset ? preset.note : "A custom font family."}>
          <Select
            aria-label="Font"
            value={preset?.label ?? "custom"}
            className="w-56"
            style={{ fontFamily: theme.fontFamily }}
            onChange={(e) => {
              const f = FONT_CHOICES.find((x) => x.label === e.target.value);
              if (f) set({ fontFamily: f.stack, googleFont: f.google });
              else applyCustom(custom || "Lato", true);
            }}
          >
            {FONT_CHOICES.map((f) => (
              <option key={f.label} value={f.label} style={{ fontFamily: f.stack }}>
                {f.label}
              </option>
            ))}
            <option value="custom">Custom…</option>
          </Select>
        </SettingRow>
        {!preset && (
          <div className="flex flex-wrap items-end gap-3 pb-3.5">
            <label className="min-w-0 flex-1 basis-52 space-y-1.5">
              <span className="block text-xs font-medium text-fg-muted">Font family name</span>
              <Input value={custom} onChange={(e) => applyCustom(e.target.value)} placeholder="e.g. Lato" maxLength={60} />
            </label>
            <label className="flex h-9 items-center gap-2 text-[13px] text-fg-muted">
              <input
                type="checkbox"
                checked={customGoogle}
                onChange={(e) => (setCustomGoogle(e.target.checked), applyCustom(custom, e.target.checked))}
                className="size-4 accent-[var(--accent)]"
              />
              Load from Google Fonts
            </label>
          </div>
        )}

        <SettingRow title="Text size" description="Scales all text in the app.">
          <div className="flex items-center gap-3">
            <span className="text-xs text-fg-muted">A</span>
            <input
              type="range"
              aria-label="Text size"
              min={0.9}
              max={1.15}
              step={0.05}
              value={theme.fontScale}
              onChange={(e) => set({ fontScale: Number(e.target.value) })}
              className="w-40 accent-[var(--accent)]"
            />
            <span className="text-base text-fg-muted">A</span>
            <span className="w-11 text-right text-xs tabular-nums text-fg-muted">{Math.round(theme.fontScale * 100)}%</span>
          </div>
        </SettingRow>

        <SettingRow title="Default color mode" description="For everyone who keeps “Use workspace default” in their profile.">
          <Segmented<ColorMode>
            label="Default color mode"
            value={theme.defaultMode}
            onChange={(defaultMode) => set({ defaultMode })}
            options={[
              { value: "system", label: "Match system" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        </SettingRow>
      </div>
    </Section>
  );
}
