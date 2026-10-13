import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Briefcase, Building2, Check, Home, LifeBuoy, Rocket, Users, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { FEATURE_KEYS, FEATURES, presetFeatures, USE_CASE_PRESETS, type UseCase } from "@shared/workspace";
import { api, errorMessage } from "@/lib/api";
import { useRefreshSetup } from "@/lib/setup";
import { cx } from "@/components/ui/primitives";
import { StepFrame, type StepProps } from "../StepFrame";

const ICONS: Record<string, LucideIcon> = { Users, Briefcase, LifeBuoy, Home, Rocket, Building2 };

export function UseCaseStep({ setup, next, skip }: StepProps) {
  const done = setup.steps.useCase === "done";
  const [picked, setPicked] = useState<UseCase | null>(done ? (setup.useCase as UseCase) : null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const refresh = useRefreshSetup();
  const off = picked ? FEATURE_KEYS.filter((k) => !presetFeatures(picked)[k]).map((k) => FEATURES[k].label) : [];

  const save = async () => {
    if (!picked) return;
    if (done && picked === setup.useCase) return next();
    setBusy(true);
    try {
      await api.put("admin/settings/workspace", { useCase: picked, applyPreset: true });
      await Promise.all([qc.invalidateQueries({ queryKey: ["workspace"] }), qc.invalidateQueries({ queryKey: ["brand"] }), refresh()]);
      next();
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <StepFrame
      title="What will you use it for?"
      description="This picks a starting look and switches on the features that fit. Nothing is locked in: you can change any of it later in Admin."
      onSkip={skip}
      onContinue={save}
      continueDisabled={!picked}
      continueLoading={busy}
    >
      <div role="radiogroup" aria-label="Use case" className="grid gap-3 sm:grid-cols-2">
        {USE_CASE_PRESETS.map((p) => {
          const Icon = ICONS[p.icon] ?? Users;
          const on = picked === p.id;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setPicked(p.id)}
              className={cx(
                "group relative flex items-start gap-3 rounded-ui-lg border bg-surface p-4 text-left shadow-ui-sm transition-[border,box-shadow,transform] duration-150 hover:-translate-y-px hover:border-line-strong",
                on ? "border-accent-ink ring-3 ring-accent-soft" : "border-line",
              )}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-ui" style={{ background: `color-mix(in oklab, ${p.theme.accent} 14%, transparent)`, color: `color-mix(in oklab, ${p.theme.accent} 55%, var(--text))` }}>
                <Icon className="size-[18px]" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-fg">{p.label}</span>
                <span className="mt-0.5 block text-[13px] text-fg-muted">{p.tagline}</span>
              </span>
              {on && (
                <span className="absolute top-3 right-3 flex size-5 items-center justify-center rounded-full bg-accent text-accent-fg">
                  <Check className="size-3" />
                </span>
              )}
            </button>
          );
        })}
      </div>
      {picked && (
        <p className="animate-fade text-[13px] text-fg-muted">
          {off.length ? (
            <>
              Switched off to start: {off.join(", ")}. Turn any of them on in <b className="text-fg">Admin → Features</b>.
            </>
          ) : (
            "Every feature is switched on."
          )}
        </p>
      )}
    </StepFrame>
  );
}
