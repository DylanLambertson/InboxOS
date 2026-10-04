import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Paintbrush, RotateCcw } from "lucide-react";
import { Link } from "react-router";
import { toast } from "sonner";
import { FEATURE_KEYS, FEATURES, presetFeatures, presetFor, USE_CASE_PRESETS, type FeatureFlags, type FeatureInfo, type FeatureKey, type UseCase, type Workspace } from "@shared/workspace";
import { api, errorMessage } from "@/lib/api";
import { useCanManage } from "@/lib/queries";
import { useUnsavedChangesGuard } from "@/lib/unsaved";
import { useWorkspace } from "@/lib/workspace";
import { Badge, Button, cx, LoadError, PageHeader, Section, Spinner, Switch } from "@/components/ui/primitives";
import { PRESET_ICONS } from "./appearance/PresetGallery";

const GROUPS: FeatureInfo["group"][] = ["Mail", "Collaboration", "Administration", "Developers"];
const GROUP_COPY: Record<FeatureInfo["group"], string> = {
  Mail: "What everyone sees while reading and writing mail.",
  Collaboration: "Working on shared inboxes together.",
  Administration: "Tools for admins and owners in the admin console.",
  Developers: "Connections to other services.",
};

const sameFlags = (a: FeatureFlags, b: FeatureFlags) => FEATURE_KEYS.every((k) => a[k] === b[k]);

/** Admin → Features: what this workspace is for, and which features are switched on. */
export function AdminFeatures() {
  const { data: saved, error, refetch, isPlaceholderData } = useWorkspace();
  const canManage = useCanManage();
  const qc = useQueryClient();
  const [useCase, setUseCase] = useState<UseCase>("team");
  const [flags, setFlags] = useState<FeatureFlags>(presetFeatures("team"));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (saved && !isPlaceholderData) {
      setUseCase(saved.useCase);
      setFlags(saved.features);
    }
  }, [saved, isPlaceholderData]);

  const preset = useMemo(() => presetFeatures(useCase), [useCase]);
  const differs = FEATURE_KEYS.filter((k) => flags[k] !== preset[k]);
  const dirty = !!saved && (useCase !== saved.useCase || !sameFlags(flags, saved.features));
  useUnsavedChangesGuard(dirty, "Your feature changes haven't been saved.");

  if (error) return <LoadError error={error} onRetry={() => refetch()} />;
  if (!saved || isPlaceholderData) return <Spinner />;

  const save = async () => {
    setBusy(true);
    try {
      const changed = Object.fromEntries(FEATURE_KEYS.filter((k) => flags[k] !== saved.features[k]).map((k) => [k, flags[k]]));
      const next = await api.put<Workspace>("admin/settings/workspace", { useCase, features: changed });
      qc.setQueryData(["workspace"], next);
      toast.success("Features saved");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Features"
        description="Turn on what your team uses and hide the rest. Switching a feature off hides it everywhere; nothing is deleted, and switching it back on brings everything back."
      />

      <Section
        title="What's this workspace for?"
        description={
          <>
            Picking a use case shows its recommended switches below; nothing changes until you save. To also apply its look, use a preset in{" "}
            <Link to="/admin/appearance" className="font-medium text-accent hover:underline">
              Appearance
            </Link>
            .
          </>
        }
      >
        <div role="radiogroup" aria-label="Use case" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {USE_CASE_PRESETS.map((p) => {
            const Icon = PRESET_ICONS[p.icon] ?? Paintbrush;
            const active = useCase === p.id;
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={!canManage}
                onClick={() => setUseCase(p.id)}
                className={cx(
                  "flex items-start gap-3 rounded-ui border p-3 text-left transition-colors disabled:cursor-default",
                  active ? "border-accent bg-accent-softer" : "border-line hover:border-line-strong hover:bg-subtle",
                )}
              >
                <span className={cx("flex size-8 shrink-0 items-center justify-center rounded-ui-sm", active ? "bg-accent text-accent-fg" : "bg-muted text-fg-muted")}>
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-[13px] font-medium">
                    {p.label}
                    {saved.useCase === p.id && <Badge>Saved</Badge>}
                  </span>
                  <span className="mt-0.5 block text-xs text-fg-muted">{p.tagline}</span>
                </span>
              </button>
            );
          })}
        </div>
      </Section>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-ui border border-line bg-subtle px-4 py-3">
        <p className="text-[13px] text-fg-muted">
          {differs.length === 0 ? (
            <>Matches the {presetFor(useCase).label} preset.</>
          ) : (
            <>
              <strong className="font-medium text-fg">{differs.length}</strong> switch{differs.length === 1 ? "" : "es"} differ from the {presetFor(useCase).label} preset.
            </>
          )}
        </p>
        <Button size="sm" variant="secondary" icon={<RotateCcw className="size-3.5" />} disabled={!canManage || differs.length === 0} onClick={() => setFlags(preset)}>
          Reset to preset
        </Button>
      </div>

      {GROUPS.map((g) => (
        <Section key={g} title={g} description={GROUP_COPY[g]}>
          <div className="divide-y divide-line">
            {FEATURE_KEYS.filter((k) => FEATURES[k].group === g).map((k) => (
              <FeatureRow key={k} k={k} on={flags[k]} recommended={preset[k]} disabled={!canManage} onChange={(v) => setFlags((f) => ({ ...f, [k]: v }))} />
            ))}
          </div>
        </Section>
      ))}

      {(dirty || busy) && (
        <div className="sticky bottom-4 z-30 mx-auto flex w-fit max-w-full flex-wrap items-center gap-3 rounded-ui-lg border border-line bg-raised px-4 py-2.5 shadow-ui-lg">
          <span className="text-[13px] text-fg-muted">Unsaved changes</span>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => (setUseCase(saved.useCase), setFlags(saved.features))}>
            Discard
          </Button>
          <Button size="sm" variant="primary" loading={busy} disabled={!canManage} onClick={save}>
            Save features
          </Button>
        </div>
      )}
    </div>
  );
}

function FeatureRow({ k, on, recommended, disabled, onChange }: { k: FeatureKey; on: boolean; recommended: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  const f = FEATURES[k];
  return (
    <div className="flex items-center justify-between gap-6 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium">
          {f.label}
          {on !== recommended && <Badge tone="warning">{recommended ? "Preset: on" : "Preset: off"}</Badge>}
        </p>
        <p className="mt-0.5 text-xs text-fg-muted">{f.description}</p>
      </div>
      <Switch checked={on} onChange={onChange} disabled={disabled} label={f.label} />
    </div>
  );
}
