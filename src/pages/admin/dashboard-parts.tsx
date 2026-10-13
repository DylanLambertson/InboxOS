import { Link } from "react-router";
import { AlertTriangle, ArrowRight, CheckCircle2, Circle, Minus, TrendingDown, TrendingUp } from "lucide-react";
import { kpiDelta, type Kpi } from "@shared/admin";
import type { HealthReport } from "@shared/health";
import { SETUP_STEPS, STEP_INFO, type PublicSetupStatus } from "@shared/setup";
import { Card, cx } from "@/components/ui/primitives";
import { healthHeadline, ScoreRing, StatusIcon, STATUS_META } from "./health-ui";

/** Tiny trend line for a KPI tile. Decorative: the number next to it carries the meaning. */
export function Sparkline({ values, color }: { values: number[]; color: string }) {
  const W = 96;
  const H = 28;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? W / (values.length - 1) : W;
  const pts = values.map((v, i) => [i * step, H - 2 - (v / max) * (H - 4)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden className="shrink-0 overflow-visible">
      <path d={`${line} L${W},${H} L0,${H} Z`} fill={color} opacity={0.12} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Delta({ kpi, goodWhenDown, days }: { kpi: Kpi; goodWhenDown?: boolean; days: number }) {
  const d = kpiDelta(kpi);
  const vs = `vs previous ${days} days`;
  if (d === null) return <p className="mt-1 text-xs text-fg-muted">New this period</p>;
  if (Math.abs(d) < 0.005)
    return (
      <p className="mt-1 flex items-center gap-1 text-xs text-fg-muted">
        <Minus className="size-3" /> No change {vs}
      </p>
    );
  const up = d > 0;
  const good = goodWhenDown ? !up : up;
  const Icon = up ? TrendingUp : TrendingDown;
  const pct = Math.abs(d) >= 10 ? `${Math.round(Math.abs(d))}×` : `${Math.round(Math.abs(d) * 100)}%`;
  return (
    <p className="mt-1 flex items-center gap-1 text-xs text-fg-muted">
      <span className={cx("inline-flex items-center gap-0.5 font-medium", good ? "text-success" : "text-danger")}>
        <Icon className="size-3" />
        {up ? "+" : "−"}
        {pct}
      </span>
      {vs}
    </p>
  );
}

export function KpiTile({ label, kpi, days, spark, color, goodWhenDown, hint }: { label: string; kpi: Kpi; days: number; spark?: number[]; color: string; goodWhenDown?: boolean; hint?: string }) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-fg-muted">{label}</p>
          <p className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums">{kpi.current.toLocaleString()}</p>
        </div>
        {spark && <Sparkline values={spark} color={color} />}
      </div>
      <Delta kpi={kpi} goodWhenDown={goodWhenDown} days={days} />
      {hint && <p className="mt-0.5 truncate text-xs text-fg-faint">{hint}</p>}
    </Card>
  );
}

export function Meter({ label, used, limit, note }: { label: string; used: number; limit: number; note?: string }) {
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  const tone = pct >= 90 ? "bg-danger" : pct >= 70 ? "bg-warning" : "bg-accent-ink";
  return (
    <Card className="p-5">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs font-medium text-fg-muted">{label}</p>
        {limit > 0 && <p className="text-xs text-fg-muted tabular-nums">{Math.round(pct)}%</p>}
      </div>
      <p className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums">
        {used.toLocaleString()}
        <span className="text-sm font-normal text-fg-muted"> / {limit ? limit.toLocaleString() : "no limit"}</span>
      </p>
      {limit > 0 && (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted" role="meter" aria-valuenow={used} aria-valuemin={0} aria-valuemax={limit} aria-label={label}>
          <div className={cx("h-full rounded-full transition-[width] duration-500", tone)} style={{ width: `${pct}%` }} />
        </div>
      )}
      {limit > 0 && pct >= 90 ? (
        <p className="mt-2 flex items-center gap-1 text-xs text-danger">
          <AlertTriangle className="size-3" /> Near the limit
        </p>
      ) : (
        note && <p className="mt-2 text-xs text-fg-muted">{note}</p>
      )}
    </Card>
  );
}

/** Health at a glance, linking to the full report. */
export function HealthCard({ report, loading }: { report?: HealthReport; loading: boolean }) {
  const top = report ? report.checks.filter((c) => c.status === "fail" || c.status === "warn").sort((a, b) => STATUS_META[a.status].rank - STATUS_META[b.status].rank) : [];
  return (
    <Card className="flex h-full flex-col p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Health</h2>
        <Link to="/admin/health" className="inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg">
          Open <ArrowRight className="size-3" />
        </Link>
      </div>
      {!report ? (
        <div className="mt-4 flex flex-1 items-center gap-4">
          <div className="size-16 animate-pulse rounded-full bg-muted" />
          <p className="text-[13px] text-fg-muted">{loading ? "Running checks…" : "Health checks aren't available right now."}</p>
        </div>
      ) : (
        <>
          <div className="mt-4 flex items-center gap-4">
            <ScoreRing score={report.score} size={64} stroke={6} />
            <div className="min-w-0">
              <p className="text-[13px] font-medium">{healthHeadline(report.counts)}</p>
              <p className="text-xs text-fg-muted">
                {report.counts.ok} passing · {report.checks.length} checks
              </p>
            </div>
          </div>
          {top.length > 0 && (
            <ul className="mt-4 space-y-2 border-t border-line pt-3">
              {top.slice(0, 4).map((c) => (
                <li key={c.id} className="flex items-start gap-2 text-[13px]">
                  <StatusIcon status={c.status} className="mt-0.5 size-3.5" />
                  <span className="min-w-0 flex-1 truncate">{c.title}</span>
                </li>
              ))}
              {top.length > 4 && <li className="pl-5.5 text-xs text-fg-muted">and {top.length - 4} more</li>}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

/** GET /api/setup/status (see shared/setup.ts). */
export type SetupStatus = PublicSetupStatus;

/** "Finish setting up": progress through the setup steps, until they're all done. */
export function SetupCard({ status }: { status: SetupStatus }) {
  const steps = SETUP_STEPS.filter((s) => s !== "done" && s !== "owner").map((s) => [s, status.steps[s] === "done"] as const);
  const done = steps.filter(([, v]) => v).length;
  const pct = steps.length ? Math.round((done / steps.length) * 100) : 0;
  return (
    <Card className="overflow-hidden border-accent-ink/30">
      <div className="flex flex-wrap items-center gap-4 bg-accent-softer px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Finish setting up</h2>
          <p className="mt-0.5 text-[13px] text-fg-muted">
            {done} of {steps.length} steps done. Mail works fully once every step is complete.
          </p>
        </div>
        <Link to="/admin/setup" className="inline-flex h-8 items-center gap-1.5 rounded-ui bg-accent px-3 text-[13px] font-medium text-accent-fg shadow-ui-sm hover:brightness-110">
          Continue setup <ArrowRight className="size-3.5" />
        </Link>
      </div>
      <div className="h-1 bg-muted">
        <div className="h-full bg-accent-ink transition-[width] duration-500" style={{ width: `${pct}%` }} />
      </div>
      <ul className="grid gap-x-6 gap-y-2 px-5 py-4 sm:grid-cols-2 lg:grid-cols-3">
        {steps.map(([key, ok]) => (
          <li key={key} className={cx("flex items-center gap-2 text-[13px]", ok ? "text-fg-muted" : "text-fg")}>
            {ok ? <CheckCircle2 className="size-4 text-success" /> : <Circle className="size-4 text-fg-faint" />}
            <span className={cx(ok && "line-through decoration-fg-faint")}>{STEP_INFO[key].label}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
