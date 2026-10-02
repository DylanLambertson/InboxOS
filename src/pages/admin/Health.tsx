import { useState } from "react";
import { Link } from "react-router";
import { ArrowRight, ExternalLink, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { HEALTH_AREA_LABELS, HEALTH_AREAS, type HealthCheck, type HealthReport, type HealthStatus } from "@shared/health";
import { errorMessage } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { useCanManage } from "@/lib/queries";
import { isConfigPath } from "@/lib/admin-nav";
import { Button, Card, cx, LoadError, PageHeader, Spinner } from "@/components/ui/primitives";
import { Tabs } from "@/components/ui/overlay";
import { useHealth, useRerunHealth } from "./health-data";
import { healthHeadline, ScoreRing, STATUS_META, StatusIcon } from "./health-ui";

const byRank = (a: HealthCheck, b: HealthCheck) => STATUS_META[a.status].rank - STATUS_META[b.status].rank;
const worst = (checks: HealthCheck[]): HealthStatus => [...checks].sort(byRank)[0]?.status ?? "ok";

function FixButton({ fix }: { fix: NonNullable<HealthCheck["fix"]> }) {
  const cls = "inline-flex h-7 shrink-0 items-center gap-1 rounded-ui border border-line bg-surface px-2.5 text-xs font-medium text-fg shadow-ui-sm hover:border-line-strong hover:bg-subtle";
  if (fix.href)
    return (
      <a href={fix.href} target="_blank" rel="noreferrer" className={cls}>
        {fix.label} <ExternalLink className="size-3" />
      </a>
    );
  return (
    <Link to={fix.to ?? "/admin"} className={cls}>
      {fix.label} <ArrowRight className="size-3" />
    </Link>
  );
}

function CheckRow({ check, canFix }: { check: HealthCheck; canFix: boolean }) {
  const fix = check.fix && (canFix || !check.fix.to || !isConfigPath(check.fix.to)) ? check.fix : undefined;
  return (
    <li className="flex items-start gap-3 px-5 py-3.5 max-sm:flex-wrap">
      <StatusIcon status={check.status} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-fg">{check.title}</p>
        <p className="mt-0.5 text-xs break-words text-fg-muted">{check.detail}</p>
      </div>
      {fix && (
        <div className="max-sm:w-full max-sm:pl-7">
          <FixButton fix={fix} />
        </div>
      )}
    </li>
  );
}

function AreaCard({ area, checks, canFix }: { area: (typeof HEALTH_AREAS)[number]; checks: HealthCheck[]; canFix: boolean }) {
  const status = worst(checks);
  const issues = checks.filter((c) => c.status === "fail" || c.status === "warn").length;
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2.5 border-b border-line px-5 py-3">
        <span className={cx("flex size-6 items-center justify-center rounded-full", STATUS_META[status].soft)}>
          <StatusIcon status={status} className="size-3.5" />
        </span>
        <h2 className="text-sm font-semibold text-fg">{HEALTH_AREA_LABELS[area]}</h2>
        <span className="ml-auto text-xs text-fg-muted">{issues ? `${issues} to review` : "All good"}</span>
      </div>
      <ul className="divide-y divide-line">
        {[...checks].sort(byRank).map((c) => (
          <CheckRow key={c.id} check={c} canFix={canFix} />
        ))}
      </ul>
    </Card>
  );
}

function Summary({ report, onRerun, running }: { report: HealthReport; onRerun: () => void; running: boolean }) {
  const chips: { status: HealthStatus; n: number }[] = (["fail", "warn", "ok", "info"] as const).map((s) => ({ status: s, n: report.counts[s] }));
  return (
    <Card className="flex items-center gap-6 p-5 max-sm:flex-col max-sm:items-start max-sm:gap-4">
      <ScoreRing score={report.score} />
      <div className="min-w-0 flex-1">
        <p className="text-base font-semibold tracking-tight text-fg">{healthHeadline(report.counts)}</p>
        <p className="mt-0.5 text-[13px] text-fg-muted">
          {report.checks.length} checks · last run {relativeTime(report.generatedAt)}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {chips.map((c) => (
            <span key={c.status} className={cx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium", STATUS_META[c.status].soft, STATUS_META[c.status].text)}>
              <StatusIcon status={c.status} className="size-3.5" />
              {c.n} {STATUS_META[c.status].label.toLowerCase()}
            </span>
          ))}
        </div>
      </div>
      <Button variant="secondary" size="sm" onClick={onRerun} loading={running} icon={<RefreshCw className="size-3.5" />} className="max-sm:w-full">
        Run checks again
      </Button>
    </Card>
  );
}

export function AdminHealth() {
  const canFix = useCanManage();
  const { data, error, isLoading, refetch } = useHealth();
  const rerun = useRerunHealth();
  const issues = data ? data.counts.fail + data.counts.warn : 0;
  const [tab, setTab] = useState<"issues" | "all" | null>(null);
  const view = tab ?? (issues ? "issues" : "all");

  const run = () => rerun.mutate(undefined, { onError: (e) => toast.error(errorMessage(e)) });

  return (
    <div className="space-y-6">
      <PageHeader title="Health" description="Checks on your email provider, domains, background jobs, sending, security and storage." />
      {error && !data ? (
        <LoadError error={error} onRetry={() => refetch()} />
      ) : isLoading || !data ? (
        <Card className="flex items-center gap-3 p-5 text-[13px] text-fg-muted">
          <Spinner /> Running checks… this can take a few seconds the first time.
        </Card>
      ) : (
        <>
          <Summary report={data} onRerun={run} running={rerun.isPending} />
          <Tabs
            value={view}
            onChange={setTab}
            tabs={[
              { value: "issues", label: `Needs attention${issues ? ` (${issues})` : ""}` },
              { value: "all", label: "All checks" },
            ]}
          />
          {(() => {
            const shown = view === "issues" ? data.checks.filter((c) => c.status === "fail" || c.status === "warn") : data.checks;
            if (!shown.length)
              return (
                <Card className="flex items-center gap-3 p-5 text-[13px] text-fg-muted">
                  <StatusIcon status="ok" /> Nothing needs attention right now.
                </Card>
              );
            const areas = HEALTH_AREAS.filter((a) => shown.some((c) => c.area === a)).sort(
              (a, b) => STATUS_META[worst(shown.filter((c) => c.area === a))].rank - STATUS_META[worst(shown.filter((c) => c.area === b))].rank,
            );
            return (
              <div className="grid items-start gap-4 lg:grid-cols-2">
                {areas.map((a) => (
                  <AreaCard key={a} area={a} checks={shown.filter((c) => c.area === a)} canFix={canFix} />
                ))}
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}
