import { useState } from "react";
import { ArrowRight, FileWarning } from "lucide-react";
import { sanitizeTheme, type ThemeTokens } from "@shared/theme";
import { Button } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlay";
import { themeDiff, themeFromFile, type ThemeChange, type ThemeFile } from "./theme-utils";

const MAX_BYTES = 64 * 1024;

/** Download the theme as a JSON file others can import. */
export function exportTheme(theme: ThemeTokens, productName: string) {
  const file: ThemeFile = { kind: "inboxos-theme", version: 1, exportedAt: new Date().toISOString(), theme };
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${productName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "theme"}-theme.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface PendingImport {
  name: string;
  theme: ThemeTokens;
  changes: ThemeChange[];
  /** Top-level keys in the file that weren't usable (unknown or invalid). */
  ignored: string[];
}

/** Read and validate a theme file against the current draft. Throws a friendly message. */
export async function readThemeFile(file: File, current: ThemeTokens): Promise<PendingImport> {
  if (file.size > MAX_BYTES) throw new Error("That file is too large to be a theme.");
  let json: unknown;
  try {
    json = JSON.parse(await file.text());
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  const raw = themeFromFile(json);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("That file doesn't contain a theme.");
  // Keys the file leaves out keep their current values; bad values are dropped, never applied.
  const theme = sanitizeTheme(raw, current);
  const known = new Set(Object.keys(current));
  const ignored = Object.entries(raw as Record<string, unknown>)
    .filter(([k, v]) => !known.has(k) || (typeof v !== "object" && v !== theme[k as keyof ThemeTokens] && String(v).toLowerCase() !== String(theme[k as keyof ThemeTokens])))
    .map(([k]) => k);
  return { name: file.name, theme, changes: themeDiff(current, theme), ignored };
}

function Value({ v, color }: { v: string; color?: boolean }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {color && <span className="size-3.5 shrink-0 rounded-sm border border-line" style={{ background: v }} />}
      <span className="truncate font-mono text-[11px]">{v}</span>
    </span>
  );
}

/** Shows what an import would change before anything is applied. */
export function ImportReview({ pending, onCancel, onApply }: { pending: PendingImport | null; onCancel: () => void; onApply: (t: ThemeTokens) => void }) {
  const [showAll, setShowAll] = useState(false);
  const list = pending ? (showAll ? pending.changes : pending.changes.slice(0, 12)) : [];
  return (
    <Modal
      open={!!pending}
      onClose={onCancel}
      title="Import theme"
      description={pending ? `From ${pending.name}. Review the changes; they go into the editor and are saved when you click Save.` : undefined}
      width={560}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" disabled={!pending?.changes.length} onClick={() => pending && onApply(pending.theme)}>
            {pending?.changes.length ? `Apply ${pending.changes.length} change${pending.changes.length === 1 ? "" : "s"}` : "Nothing to change"}
          </Button>
        </>
      }
    >
      {pending && (
        <div className="space-y-3">
          {pending.changes.length === 0 ? (
            <p className="text-[13px] text-fg-muted">This theme is the same as what you have now.</p>
          ) : (
            <ul className="divide-y divide-line rounded-ui border border-line">
              {list.map((c) => (
                <li key={c.key} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-2 px-3 py-2 text-[13px]">
                  <span className="min-w-0 truncate">{c.label}</span>
                  <Value v={c.from} color={c.color} />
                  <ArrowRight className="size-3 text-fg-faint" />
                  <Value v={c.to} color={c.color} />
                </li>
              ))}
            </ul>
          )}
          {pending.changes.length > 12 && !showAll && (
            <button className="text-xs font-medium text-accent hover:underline" onClick={() => setShowAll(true)}>
              Show all {pending.changes.length} changes
            </button>
          )}
          {pending.ignored.length > 0 && (
            <p className="flex items-start gap-2 rounded-ui bg-warning-soft px-3 py-2 text-xs text-warning">
              <FileWarning className="mt-0.5 size-3.5 shrink-0" />
              Skipped values that aren't valid or aren't part of a theme: {pending.ignored.join(", ")}.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
