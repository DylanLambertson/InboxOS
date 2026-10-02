import { CircleAlert, CircleCheck, CircleX, Info } from "lucide-react";
import type { HealthStatus } from "@shared/health";
import { cx } from "@/components/ui/primitives";

export const STATUS_META: Record<HealthStatus, { label: string; icon: typeof CircleCheck; text: string; soft: string; rank: number }> = {
  fail: { label: "Failing", icon: CircleX, text: "text-danger", soft: "bg-danger-soft", rank: 0 },
  warn: { label: "Needs attention", icon: CircleAlert, text: "text-warning", soft: "bg-warning-soft", rank: 1 },
  info: { label: "Info", icon: Info, text: "text-fg-muted", soft: "bg-muted", rank: 2 },
  ok: { label: "Passing", icon: CircleCheck, text: "text-success", soft: "bg-success-soft", rank: 3 },
};

export function StatusIcon({ status, className }: { status: HealthStatus; className?: string }) {
  const m = STATUS_META[status];
  return <m.icon aria-label={m.label} className={cx("size-4 shrink-0", m.text, className)} />;
}

export const scoreTone = (score: number) => (score >= 90 ? "var(--success)" : score >= 70 ? "var(--warning)" : "var(--danger)");

/** Circular 0–100 score. */
export function ScoreRing({ score, size = 96, stroke = 8, label = "Health score" }: { score: number; size?: number; stroke?: number; label?: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, score));
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} role="img" aria-label={`${label}: ${clamped} out of 100`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--bg-muted)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={scoreTone(clamped)}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - clamped / 100)}
          style={{ transition: "stroke-dashoffset 600ms ease" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-semibold tracking-tight tabular-nums" style={{ fontSize: size * 0.28 }}>
          {clamped}
        </span>
        {size >= 80 && <span className="text-[10px] font-medium tracking-wide text-fg-muted uppercase">score</span>}
      </div>
    </div>
  );
}

/** One-line verdict for a report. */
export function healthHeadline(counts: Record<HealthStatus, number>): string {
  if (counts.fail) return `${counts.fail} problem${counts.fail === 1 ? "" : "s"} to fix${counts.warn ? `, ${counts.warn} to review` : ""}`;
  if (counts.warn) return `${counts.warn} thing${counts.warn === 1 ? "" : "s"} to review`;
  return "Everything looks good";
}
