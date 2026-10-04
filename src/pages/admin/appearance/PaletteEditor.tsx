import { useState } from "react";
import { AlertTriangle, CheckCircle2, RotateCcw } from "lucide-react";
import { contrastLevel, paletteContrastChecks, type ContrastCheck } from "@shared/contrast";
import { PALETTE_KEYS, resolvePalettes, type Palette, type ThemeTokens } from "@shared/theme";
import { Badge, Button, cx, IconButton, Section } from "@/components/ui/primitives";
import { Tabs } from "@/components/ui/overlay";
import { ColorField } from "./controls";
import { BASES, PALETTE_LABELS, type Mode } from "./theme-utils";

const GROUPS: { title: string; keys: (keyof Palette)[] }[] = [
  { title: "Surfaces", keys: ["bg", "bgSubtle", "bgMuted", "surface", "surfaceRaised"] },
  { title: "Lines", keys: ["border", "borderStrong"] },
  { title: "Text", keys: ["text", "textMuted", "textFaint"] },
  { title: "Status", keys: ["danger", "success", "warning"] },
];

/** Which palette keys take part in a failing check, so their rows can be flagged. */
const keysIn = (checks: ContrastCheck[]) =>
  new Set(checks.filter((c) => !c.ok).flatMap((c) => c.id.split("/")).filter((k): k is keyof Palette => (PALETTE_KEYS as readonly string[]).includes(k)));

export function PaletteEditor({ theme, set }: { theme: ThemeTokens; set: (patch: Partial<ThemeTokens>) => void }) {
  const [mode, setMode] = useState<Mode>("light");
  const palettes = resolvePalettes(theme);
  const checks = { light: paletteContrastChecks(palettes.light, theme.accent), dark: paletteContrastChecks(palettes.dark, theme.accent) };
  const issues = (m: Mode) => checks[m].filter((c) => !c.ok).length;
  const p = palettes[mode];
  const overrides = theme[mode];
  const flagged = keysIn(checks[mode]);

  const setKey = (k: keyof Palette, hex: string) => {
    const next: Partial<Palette> = { ...overrides };
    // Matching the built-in value is the same as no override, which keeps exports small.
    if (hex === BASES[mode][k]) delete next[k];
    else next[k] = hex;
    set({ [mode]: next } as Partial<ThemeTokens>);
  };
  const resetKey = (k: keyof Palette) => {
    const next: Partial<Palette> = { ...overrides };
    delete next[k];
    set({ [mode]: next } as Partial<ThemeTokens>);
  };
  const overrideCount = Object.keys(overrides).length;

  return (
    <Section
      title="Colors"
      description="Fine-tune every color for light and dark mode. Anything you don't change follows the built-in palette."
      actions={
        overrideCount > 0 ? (
          <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => set({ [mode]: {} } as Partial<ThemeTokens>)}>
            Reset {mode}
          </Button>
        ) : undefined
      }
    >
      <div className="mb-4">
        <Tabs<Mode>
          value={mode}
          onChange={setMode}
          tabs={(["light", "dark"] as const).map((m) => ({
            value: m,
            label: (
              <span className="inline-flex items-center gap-1.5">
                {m === "light" ? "Light" : "Dark"}
                {issues(m) > 0 && (
                  <span className="inline-flex items-center gap-0.5 text-warning" aria-label={`${issues(m)} contrast warnings`}>
                    <AlertTriangle className="size-3" />
                    {issues(m)}
                  </span>
                )}
              </span>
            ),
          }))}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {GROUPS.map((g) => (
          <div key={g.title}>
            <h3 className="mb-1 text-[11px] font-semibold tracking-wide text-fg-faint uppercase">{g.title}</h3>
            <div className="divide-y divide-line">
              {g.keys.map((k) => (
                <div key={k} className="flex items-center gap-3 py-2">
                  <span className="min-w-0 flex-1 text-[13px]">
                    {PALETTE_LABELS[k]}
                    {k in overrides && <span className="ml-1.5 text-[11px] text-accent">custom</span>}
                    {flagged.has(k) && <AlertTriangle className="ml-1.5 inline size-3 text-warning" aria-label="Low contrast" />}
                  </span>
                  <ColorField label={PALETTE_LABELS[k]} value={p[k]} onChange={(hex) => setKey(k, hex)} invalid={flagged.has(k)} />
                  <IconButton size="sm" label="Reset to base" disabled={!(k in overrides)} onClick={() => resetKey(k)}>
                    <RotateCcw className="size-3.5" />
                  </IconButton>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <ContrastReport checks={checks[mode]} mode={mode} />
    </Section>
  );
}

function ContrastReport({ checks, mode }: { checks: ContrastCheck[]; mode: Mode }) {
  const failing = checks.filter((c) => !c.ok);
  return (
    <div className={cx("mt-6 rounded-ui border p-4", failing.length ? "border-warning/40 bg-warning-soft" : "border-line bg-subtle")}>
      <div className="mb-3 flex items-center gap-2 text-[13px] font-medium">
        {failing.length ? <AlertTriangle className="size-4 text-warning" /> : <CheckCircle2 className="size-4 text-success" />}
        {failing.length
          ? `${failing.length} pairing${failing.length === 1 ? "" : "s"} in ${mode} mode may be hard to read`
          : `Everything in ${mode} mode meets WCAG contrast guidelines`}
      </div>
      <ul className="grid gap-2 sm:grid-cols-2">
        {checks.map((c) => (
          <li key={c.id} className="flex items-center gap-2.5 rounded-ui-sm bg-surface px-2.5 py-2 text-xs">
            <span className="flex h-6 w-9 shrink-0 items-center justify-center rounded-ui-sm border border-line text-[11px] font-semibold" style={{ background: c.bg, color: c.fg }}>
              Aa
            </span>
            <span className="min-w-0 flex-1 truncate">{c.label}</span>
            <span className="tabular-nums text-fg-muted">{c.ratio.toFixed(2)}:1</span>
            <Badge tone={c.ok ? "success" : "warning"}>{c.ok ? contrastLevel(c.ratio) : `Needs ${c.min}:1`}</Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}
