import { useState } from "react";
import { Briefcase, Building2, Home, LifeBuoy, Paintbrush, Rocket, ToggleRight, Users, type LucideIcon } from "lucide-react";
import { DEFAULT_THEME, sanitizeTheme, type ThemeTokens } from "@shared/theme";
import { FEATURES, FEATURE_KEYS, presetFeatures, USE_CASE_PRESETS, type FeatureFlags, type UseCasePreset } from "@shared/workspace";
import { Badge, Button, cx, Section } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlay";
import { scopedThemeStyle } from "./theme-utils";

export const PRESET_ICONS: Record<string, LucideIcon> = { Users, Briefcase, LifeBuoy, Home, Rocket, Building2 };

/** The full theme a preset produces on top of a base. */
export const presetTheme = (p: UseCasePreset, base: ThemeTokens = DEFAULT_THEME) => sanitizeTheme({ ...base, ...p.theme }, base);

function Swatch({ preset }: { preset: UseCasePreset }) {
  const theme = presetTheme(preset);
  const row = (w: string, unread = false) => (
    <div className="flex items-center gap-1 border-b border-line px-1.5 py-1">
      <span className="size-2.5 rounded-full bg-muted" />
      <span className={cx("h-1 rounded-full", unread ? "bg-fg" : "bg-line-strong")} style={{ width: w }} />
      {unread && <span className="ml-auto size-1 rounded-full bg-accent" />}
    </div>
  );
  return (
    <div style={scopedThemeStyle(theme, "light")} className="flex h-20 overflow-hidden rounded-ui border border-line" aria-hidden>
      <div className="w-[34%] space-y-1 border-r border-line bg-subtle p-1.5">
        <div className="h-2.5 rounded-ui-sm bg-accent" />
        <div className="h-1.5 rounded-ui-sm bg-accent-soft" />
        <div className="h-1.5 w-3/4 rounded-full bg-line" />
        <div className="h-1.5 w-2/3 rounded-full bg-line" />
      </div>
      <div className="flex-1 bg-bg">
        {row("60%", true)}
        {row("45%")}
        {row("52%")}
        <div className="flex justify-end p-1">
          <span className="h-2.5 w-8 rounded-ui-sm bg-accent" />
        </div>
      </div>
    </div>
  );
}

/** Use-case presets as cards; picking one offers the look alone, or look and features. */
export function PresetGallery({
  currentUseCase,
  features,
  isOwner,
  onApplyLook,
  onApplyAll,
}: {
  currentUseCase: string | undefined;
  features: FeatureFlags | undefined;
  isOwner: boolean;
  onApplyLook: (p: UseCasePreset) => void;
  onApplyAll: (p: UseCasePreset) => Promise<void>;
}) {
  const [picked, setPicked] = useState<UseCasePreset | null>(null);
  const [busy, setBusy] = useState(false);
  const changes = picked && features ? FEATURE_KEYS.filter((k) => presetFeatures(picked.id)[k] !== features[k]) : [];

  return (
    <Section title="Start from a preset" description="Each use case comes with a look. Pick one as a starting point, then adjust anything below.">
      <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
        {USE_CASE_PRESETS.map((p) => {
          const Icon = PRESET_ICONS[p.icon] ?? Paintbrush;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => setPicked(p)}
              aria-current={currentUseCase === p.id || undefined}
              className={cx(
                "group flex flex-col gap-2.5 rounded-ui-lg border bg-surface p-3 text-left transition-colors hover:bg-subtle focus-visible:border-accent",
                currentUseCase === p.id ? "border-accent" : "border-line hover:border-line-strong",
              )}
            >
              <Swatch preset={p} />
              <div className="flex items-start gap-2">
                <Icon className="mt-0.5 size-4 shrink-0 text-fg-muted" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium">
                    {p.label}
                    {currentUseCase === p.id && <Badge tone="accent">Current</Badge>}
                  </div>
                  <p className="mt-0.5 text-xs text-fg-muted">{p.tagline}</p>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <Modal
        open={!!picked}
        onClose={() => !busy && setPicked(null)}
        title={picked ? `Use the ${picked.label} preset` : ""}
        description="Choose what to take from it. You can change every setting afterwards."
        width={520}
      >
        {picked && (
          <div className="space-y-3">
            <Swatch preset={picked} />
            <button
              type="button"
              onClick={() => (onApplyLook(picked), setPicked(null))}
              className="flex w-full items-start gap-3 rounded-ui border border-line p-3 text-left transition-colors hover:border-accent hover:bg-accent-softer"
            >
              <Paintbrush className="mt-0.5 size-4 shrink-0 text-accent" />
              <span>
                <span className="block text-[13px] font-medium">Just the look</span>
                <span className="block text-xs text-fg-muted">Accent, corners and density go into the editor below. Nothing is saved until you click Save.</span>
              </span>
            </button>
            <div className={cx("rounded-ui border border-line p-3", !isOwner && "opacity-60")}>
              <div className="flex items-start gap-3">
                <ToggleRight className="mt-0.5 size-4 shrink-0 text-accent" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium">Look and features</p>
                  <p className="text-xs text-fg-muted">
                    Saves the look now and switches features to this use case's defaults.
                    {Object.keys(picked.policy).length > 0 && " Also applies its policy defaults"}
                    {picked.policy.require2fa ? " (everyone will need two-factor authentication)." : Object.keys(picked.policy).length ? "." : ""}
                  </p>
                  {changes.length > 0 && (
                    <ul className="mt-2 flex flex-wrap gap-1">
                      {changes.map((k) => (
                        <li key={k}>
                          <Badge tone={presetFeatures(picked.id)[k] ? "success" : "neutral"}>
                            {presetFeatures(picked.id)[k] ? "On" : "Off"}: {FEATURES[k].label}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                  {!isOwner && <p className="mt-2 text-xs text-fg-muted">Only owners can apply a whole preset, because it can change security policy.</p>}
                </div>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!isOwner}
                  loading={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await onApplyAll(picked);
                      setPicked(null);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Apply
                </Button>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </Section>
  );
}
