import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Download, Eye, RotateCcw, Upload } from "lucide-react";
import { toast } from "sonner";
import type { Brand } from "@shared/brand";
import { DEFAULT_THEME, sanitizeTheme, type ThemeTokens } from "@shared/theme";
import type { UseCasePreset, Workspace } from "@shared/workspace";
import { api, errorMessage } from "@/lib/api";
import { regenerateAppIcons } from "@/lib/app-icons";
import { applyThemeTokens, useBrand } from "@/lib/brand";
import { useCanManage, useMe } from "@/lib/queries";
import { useUnsavedChangesGuard } from "@/lib/unsaved";
import { useWorkspace } from "@/lib/workspace";
import { Button, PageHeader, Switch } from "@/components/ui/primitives";
import { useConfirm } from "@/components/ui/overlay";
import { exportTheme, ImportReview, readThemeFile, type PendingImport } from "./appearance/ImportTheme";
import { PaletteEditor } from "./appearance/PaletteEditor";
import { PresetGallery, presetTheme } from "./appearance/PresetGallery";
import { ThemePreview } from "./appearance/ThemePreview";
import { TokenEditor } from "./appearance/TokenEditor";
import { themeDiff } from "./appearance/theme-utils";

const same = (a: ThemeTokens, b: ThemeTokens) => JSON.stringify(a) === JSON.stringify(b);

/** Admin → Appearance: the workspace theme studio. */
export function AdminAppearance() {
  const brand = useBrand();
  const saved = brand.theme;
  const qc = useQueryClient();
  const confirm = useConfirm();
  const canManage = useCanManage();
  const { data: me } = useMe();
  const { data: workspace } = useWorkspace();
  const [draft, setDraft] = useState<ThemeTokens>(saved);
  const [busy, setBusy] = useState(false);
  const [previewApp, setPreviewApp] = useState(false);
  const [pending, setPending] = useState<PendingImport | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirty = !same(draft, saved);
  const changes = dirty ? themeDiff(saved, draft).length : 0;

  // Follow the saved theme (another admin, a preset) while there's nothing unsaved here.
  const savedRef = useRef(saved);
  useEffect(() => {
    if (same(draft, savedRef.current)) setDraft(saved);
    savedRef.current = saved;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  // "Preview on the whole app" writes the draft to the page; otherwise (and on leaving) the saved theme.
  useEffect(() => {
    applyThemeTokens(previewApp ? draft : savedRef.current);
  }, [previewApp, draft, saved]);
  useEffect(() => () => applyThemeTokens(savedRef.current), []);

  useUnsavedChangesGuard(dirty, "Your theme changes haven't been saved.");

  const set = (patch: Partial<ThemeTokens>) => setDraft((t) => sanitizeTheme({ ...t, ...patch }, t));

  const save = async () => {
    setBusy(true);
    try {
      const next = await api.put<Brand>("admin/settings/brand", { theme: draft as unknown as Record<string, unknown> });
      qc.setQueryData(["brand"], next);
      savedRef.current = next.theme;
      setDraft(next.theme);
      toast.success("Appearance saved for everyone");
      if (next.theme.accent !== saved.accent) {
        // Home-screen icons are drawn on the accent color.
        regenerateAppIcons(next).catch(() => toast.error("Couldn't update the app icon. Save again to retry."));
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const applyWholePreset = async (p: UseCasePreset) => {
    if (dirty && !(await confirm({ title: "Discard unsaved changes?", body: "Applying the whole preset saves its look now, replacing what's in the editor.", confirmLabel: "Apply preset" }))) return;
    try {
      const ws = await api.put<Workspace>("admin/settings/workspace", { useCase: p.id, applyPreset: true });
      qc.setQueryData(["workspace"], ws);
      const next = await api.get<Brand>("/api/brand");
      qc.setQueryData(["brand"], next);
      savedRef.current = next.theme;
      setDraft(next.theme);
      qc.invalidateQueries({ queryKey: ["admin-settings"] });
      toast.success(`${p.label} preset applied`);
      if (next.theme.accent !== saved.accent) regenerateAppIcons(next).catch(() => undefined);
    } catch (e) {
      toast.error(errorMessage(e));
      throw e;
    }
  };

  const importFile = async (file: File) => {
    try {
      setPending(await readThemeFile(file, draft));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Appearance"
        description="The look of the app for everyone in your workspace: colors, shape, type and spacing."
        actions={
          <>
            <Button variant="ghost" size="sm" icon={<Upload className="size-4" />} disabled={!canManage} onClick={() => fileInput.current?.click()}>
              Import
            </Button>
            <Button variant="ghost" size="sm" icon={<Download className="size-4" />} onClick={() => exportTheme(draft, brand.productName)}>
              Export
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={<RotateCcw className="size-4" />}
              disabled={!canManage || same(draft, DEFAULT_THEME)}
              onClick={async () => {
                if (await confirm({ title: "Reset to the default look?", body: "The editor goes back to the built-in theme. Nothing is saved until you click Save.", confirmLabel: "Reset" })) setDraft(DEFAULT_THEME);
              }}
            >
              Reset to default
            </Button>
          </>
        }
      />
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void importFile(f);
        }}
      />

      {!canManage && (
        <p className="rounded-ui border border-line bg-subtle px-4 py-3 text-[13px] text-fg-muted">You can look around, but only admins can change the appearance.</p>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-6">
          <PresetGallery
            currentUseCase={workspace?.useCase}
            features={workspace?.features}
            isOwner={me?.role === "owner"}
            onApplyLook={(p) => {
              setDraft((t) => presetTheme(p, t));
              toast.info(`${p.label} look loaded into the editor. Save to apply it for everyone.`);
            }}
            onApplyAll={applyWholePreset}
          />
          <TokenEditor theme={draft} set={set} />
          <PaletteEditor theme={draft} set={set} />
        </div>

        <aside className="min-w-0 xl:sticky xl:top-0 xl:self-start">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[13px] font-medium">Live preview</p>
            <label className="flex items-center gap-2 text-xs text-fg-muted">
              <Eye className="size-3.5" />
              Preview on the whole app
              <Switch checked={previewApp} onChange={setPreviewApp} label="Preview on the whole app" />
            </label>
          </div>
          <ThemePreview theme={draft} brand={brand} />
          <p className="mt-3 text-xs text-fg-muted">
            People choose light, dark or their device's setting in their profile; the default color mode applies to everyone who hasn't.
          </p>
        </aside>
      </div>

      {(dirty || busy) && (
        <div className="sticky bottom-4 z-30 mx-auto flex w-fit max-w-full flex-wrap items-center gap-3 rounded-ui-lg border border-line bg-raised px-4 py-2.5 shadow-ui-lg">
          <span className="text-[13px] text-fg-muted">
            {changes} unsaved change{changes === 1 ? "" : "s"}
          </span>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(saved)}>
            Discard
          </Button>
          <Button size="sm" variant="primary" loading={busy} disabled={!canManage} onClick={save}>
            Save for everyone
          </Button>
        </div>
      )}

      <ImportReview
        pending={pending}
        onCancel={() => setPending(null)}
        onApply={(t) => {
          setDraft(t);
          setPending(null);
          toast.info("Theme imported into the editor. Save to apply it for everyone.");
        }}
      />
    </div>
  );
}
