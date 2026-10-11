import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Download, MinusCircle, XCircle } from "lucide-react";
import { countResults, type BulkResult, type BulkRowResult, type BulkRowStatus } from "@shared/admin";
import { api, errorMessage } from "@/lib/api";
import { Button, cx, Input, Spinner } from "@/components/ui/primitives";
import { Modal, Tabs } from "@/components/ui/overlay";
import { downloadCsv } from "./download";

export interface BulkSpec {
  endpoint: string;
  action: string;
  params?: Record<string, unknown>;
  /** e.g. "Disable people". */
  title: string;
  /** What will happen, in a sentence. */
  description?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** Ask for this word to be typed before running (and send it as params.confirm). */
  typeToConfirm?: string;
  /** Rows per request. */
  chunk: number;
  noun: string;
}

export interface BulkTargets {
  ids?: string[];
  filter?: Record<string, string>;
}

type Phase = "checking" | "review" | "running" | "done" | "error";

const STATUS_UI: Record<BulkRowStatus, { label: string; icon: ReactNode; tone: string }> = {
  ok: { label: "Will change", icon: <CheckCircle2 className="size-4" />, tone: "text-success" },
  skipped: { label: "Skipped", icon: <MinusCircle className="size-4" />, tone: "text-fg-muted" },
  failed: { label: "Can't change", icon: <XCircle className="size-4" />, tone: "text-danger" },
  remaining: { label: "Still running", icon: <Spinner className="size-4" />, tone: "text-warning" },
};

/**
 * Bulk action flow: a dry run explains what will happen to every row, the admin
 * confirms, then the change runs in chunks with a progress bar and ends with a
 * per-row report (failures included) that can be downloaded.
 */
export function BulkDialog({ spec, targets, onClose, onDone }: { spec: BulkSpec; targets: BulkTargets; onClose: () => void; onDone: () => void }) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [plan, setPlan] = useState<BulkRowResult[]>([]);
  const [final, setFinal] = useState<BulkRowResult[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState("");
  const [typed, setTyped] = useState("");
  const [tab, setTab] = useState<BulkRowStatus | "all">("all");

  useEffect(() => {
    let cancelled = false;
    api
      .post<BulkResult>(spec.endpoint, { ...targets, action: spec.action, params: spec.params ?? {}, dryRun: true })
      .then((r) => {
        if (cancelled) return;
        setPlan(r.results);
        setPhase("review");
      })
      .catch((e) => !cancelled && (setError(errorMessage(e)), setPhase("error")));
    return () => {
      cancelled = true;
    };
    // The dialog is opened fresh for each action.
  }, []);

  const run = async () => {
    const ids = plan.filter((r) => r.status === "ok").map((r) => r.id);
    const byId = new Map(plan.map((r) => [r.id, r]));
    setProgress({ done: 0, total: ids.length });
    setPhase("running");
    let queue = ids;
    const params = { ...(spec.params ?? {}), ...(spec.typeToConfirm ? { confirm: typed.trim().toLowerCase() } : {}) };
    // Long-running actions (deleting mailboxes) report rows as "remaining" until finished.
    for (let round = 0; queue.length && round < 200; round++) {
      const remaining: string[] = [];
      for (let i = 0; i < queue.length; i += spec.chunk) {
        const chunk = queue.slice(i, i + spec.chunk);
        try {
          const r = await api.post<BulkResult>(spec.endpoint, { ids: chunk, action: spec.action, params, dryRun: false });
          for (const row of r.results) {
            byId.set(row.id, row);
            if (row.status === "remaining") remaining.push(row.id);
          }
        } catch (e) {
          for (const id of chunk) byId.set(id, { ...(byId.get(id) ?? { id, label: id }), status: "failed", message: errorMessage(e) } as BulkRowResult);
        }
        if (round === 0) setProgress({ done: Math.min(ids.length, i + chunk.length), total: ids.length });
      }
      queue = remaining;
    }
    setFinal([...byId.values()]);
    setPhase("done");
    onDone();
  };

  const rows = phase === "done" ? final : plan;
  const counts = useMemo(() => countResults(rows), [rows]);
  const shown = tab === "all" ? rows : rows.filter((r) => r.status === tab);
  const blocked = !!spec.typeToConfirm && typed.trim().toLowerCase() !== spec.typeToConfirm.toLowerCase();
  const report = () =>
    downloadCsv(`bulk-${spec.action}`, [["item", "result", "detail"], ...rows.map((r) => [r.label, phase === "done" && r.status === "ok" ? "done" : r.status, r.message ?? ""])]);

  return (
    <Modal
      open
      onClose={phase === "running" ? () => {} : onClose}
      title={phase === "done" ? "Done" : spec.title}
      description={phase === "review" ? spec.description : undefined}
      width={620}
      footer={
        phase === "review" ? (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant={spec.danger ? "danger" : "primary"} disabled={!counts.ok || blocked} onClick={run}>
              {counts.ok ? `${spec.confirmLabel} (${counts.ok.toLocaleString()})` : "Nothing to change"}
            </Button>
          </>
        ) : phase === "done" || phase === "error" ? (
          <>
            {phase === "done" && (
              <Button icon={<Download className="size-4" />} onClick={report}>
                Download report
              </Button>
            )}
            <Button variant="primary" onClick={onClose}>Close</Button>
          </>
        ) : undefined
      }
    >
      {phase === "checking" && (
        <div className="flex items-center gap-2 py-6 text-[13px] text-fg-muted">
          <Spinner /> Checking what will change…
        </div>
      )}
      {phase === "error" && (
        <p className="flex items-start gap-2 rounded-ui bg-danger-soft p-3 text-[13px] text-danger">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {error}
        </p>
      )}
      {phase === "running" && (
        <div className="space-y-3 py-4">
          <p className="text-[13px] text-fg-muted">
            Working… {progress.done.toLocaleString()} of {progress.total.toLocaleString()} {spec.noun}. Keep this window open.
          </p>
          <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
            <div className="h-full bg-accent transition-[width]" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
          </div>
        </div>
      )}
      {(phase === "review" || phase === "done") && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            {(["ok", "skipped", "failed"] as const).map((s) => (
              <div key={s} className="rounded-ui border border-line p-3">
                <p className={cx("flex items-center gap-1.5 text-xs font-medium", STATUS_UI[s].tone)}>
                  {STATUS_UI[s].icon} {phase === "done" && s === "ok" ? "Done" : phase === "done" && s === "failed" ? "Failed" : STATUS_UI[s].label}
                </p>
                <p className="mt-1 text-lg font-semibold tabular-nums">{counts[s].toLocaleString()}</p>
              </div>
            ))}
          </div>
          {rows.length > 1 && (
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[{ value: "all", label: "All" }, ...(["ok", "skipped", "failed"] as const).filter((s) => counts[s]).map((s) => ({ value: s, label: phase === "done" && s === "ok" ? "Done" : STATUS_UI[s].label }))]}
            />
          )}
          <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-ui border border-line">
            {shown.slice(0, 1000).map((r) => (
              <li key={r.id} className="flex items-start gap-2.5 px-3 py-2 text-[13px]">
                <span className={cx("mt-0.5 shrink-0", STATUS_UI[r.status].tone)}>{STATUS_UI[r.status].icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{r.label}</span>
                  {r.message && <span className="block text-xs text-fg-muted">{r.message}</span>}
                </span>
              </li>
            ))}
            {!shown.length && <li className="px-3 py-4 text-center text-xs text-fg-muted">Nothing here.</li>}
          </ul>
          {phase === "review" && spec.typeToConfirm && counts.ok > 0 && (
            <div className="space-y-1.5">
              <p className="text-[13px] text-fg-muted">
                Type <span className="font-mono font-medium text-fg">{spec.typeToConfirm}</span> to confirm.
              </p>
              <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus aria-label="Confirmation" />
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
