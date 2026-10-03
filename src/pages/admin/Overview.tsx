import { useMemo } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import type { OverviewData } from "@shared/admin";
import { api, ApiError } from "@/lib/api";
import { fileSize, relativeTime } from "@/lib/format";
import { Button, Card, LoadError, PageHeader, Section } from "@/components/ui/primitives";
import { EVENT_LABELS } from "@/components/mail/StatusBadge";
import { useCanManage } from "@/lib/queries";
import { ActivityChart, dailyPoints } from "./ActivityChart";
import { HealthCard, KpiTile, Meter, SetupCard, type SetupStatus } from "./dashboard-parts";
import { useHealth } from "./health-data";

export type { OverviewData };

const OVERVIEW_KEY = ["admin-overview"] as const;

/** The setup wizard's progress, when this install has one (older servers answer 404). */
function useSetupStatus(enabled: boolean) {
  return useQuery({
    queryKey: ["setup-status"],
    queryFn: async () => {
      try {
        return await api.get<SetupStatus>("/api/setup/status");
      } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.status === 403)) return null;
        throw e;
      }
    },
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

function Skeleton({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded-ui-lg border border-line bg-muted/60 ${className ?? ""}`} />;
}

export function AdminOverview() {
  const editable = useCanManage();
  // Three independent requests, all in flight at once: no waterfall.
  const overview = useQuery({ queryKey: OVERVIEW_KEY, queryFn: () => api.get<OverviewData>("admin/overview"), refetchInterval: 60_000, staleTime: 20_000 });
  const health = useHealth();
  const setup = useSetupStatus(editable);
  const data = overview.data;
  const points = useMemo(() => (data ? dailyPoints(data.series) : []), [data]);
  const refreshing = overview.isFetching && !overview.isLoading;

  if (overview.error && !data) return <LoadError error={overview.error} onRetry={() => overview.refetch()} />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description={data ? `Activity, quotas and health · updated ${relativeTime(data.generatedAt)}` : "Activity, quotas and health"}
        actions={
          <Button variant="ghost" size="sm" onClick={() => overview.refetch()} loading={refreshing} icon={<RefreshCw className="size-3.5" />}>
            Refresh
          </Button>
        }
      />

      {setup.data && !setup.data.completed && Object.keys(setup.data.steps ?? {}).length > 0 && <SetupCard status={setup.data} />}

      {!data ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[118px]" />
            ))}
          </div>
          <Skeleton className="h-72" />
        </>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KpiTile label={`Sent · last ${data.kpiDays} days`} kpi={data.kpis.sent} days={data.kpiDays} spark={points.map((p) => p.sent)} color="var(--series-1)" />
            <KpiTile label={`Received · last ${data.kpiDays} days`} kpi={data.kpis.received} days={data.kpiDays} spark={points.map((p) => p.received)} color="var(--series-2)" />
            <KpiTile
              label={`Bounces · last ${data.kpiDays} days`}
              kpi={data.kpis.bounces}
              days={data.kpiDays}
              spark={points.map((p) => p.bounced)}
              color="var(--danger)"
              goodWhenDown
              hint={data.kpis.complaints.current ? `${data.kpis.complaints.current} spam complaint${data.kpis.complaints.current === 1 ? "" : "s"}` : undefined}
            />
            <KpiTile
              label={`Active people · last ${data.kpiDays} days`}
              kpi={data.kpis.activeUsers}
              days={data.kpiDays}
              color="var(--series-3)"
              hint={`${data.counts.users} active account${data.counts.users === 1 ? "" : "s"}${data.counts.invited ? ` · ${data.counts.invited} invited` : ""}`}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Meter label="Sent today (UTC)" used={data.usage.today} limit={data.usage.dailyLimit} note={`Includes ${data.usage.systemToday} system email${data.usage.systemToday === 1 ? "" : "s"}`} />
            <Meter label="Sent this month" used={data.usage.month} limit={data.usage.monthlyLimit} note={`Includes ${data.usage.systemMonth} system email${data.usage.systemMonth === 1 ? "" : "s"}`} />
            <Card className="p-5">
              <p className="text-xs font-medium text-fg-muted">Storage</p>
              <p className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums">{fileSize(data.counts.bytes)}</p>
              <p className="mt-1 text-xs text-fg-muted">{data.counts.messages.toLocaleString()} messages</p>
            </Card>
            <Card className="p-5">
              <p className="text-xs font-medium text-fg-muted">Mailboxes</p>
              <p className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums">{data.counts.mailboxes}</p>
              <p className="mt-1 text-xs text-fg-muted">
                {data.counts.scheduled ? `${data.counts.scheduled} message${data.counts.scheduled === 1 ? "" : "s"} scheduled` : "Nothing scheduled"}
                {data.counts.unrouted ? (
                  <>
                    {" · "}
                    <Link to="/admin/traffic" className="text-warning hover:underline">
                      {data.counts.unrouted} unrouted
                    </Link>
                  </>
                ) : null}
              </p>
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <Section title="Activity" description="Sent and received over the last 14 days, including system emails like invites and password resets.">
                <ActivityChart rows={data.series} />
              </Section>
            </div>
            <HealthCard report={health.data} loading={health.isLoading} />
          </div>

          <Section
            title="Recent problems"
            description="Bounces, complaints, failures and mail nobody owns."
            actions={
              <Link to="/admin/logs/delivery" className="shrink-0 text-xs text-fg-muted hover:text-fg">
                Delivery log →
              </Link>
            }
          >
            {data.recentProblems.length === 0 ? (
              <p className="flex items-center gap-2 text-[13px] text-fg-muted">
                <CheckCircle2 className="size-4 text-success" /> No bounces, complaints or failures recently.
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {data.recentProblems.map((p) => (
                  <li key={p.id} className="py-2 first:pt-0 last:pb-0">
                    <p className="flex items-center gap-2 text-[13px]">
                      <AlertTriangle className={p.type === "received.unrouted" || p.type === "delivery_delayed" ? "size-3.5 shrink-0 text-warning" : "size-3.5 shrink-0 text-danger"} />
                      <span className="font-medium">{EVENT_LABELS[p.type] ?? p.type}</span>
                      <span className="ml-auto shrink-0 text-xs text-fg-muted">{relativeTime(p.created_at)}</span>
                    </p>
                    <p className="truncate pl-5.5 text-xs text-fg-muted">{[p.recipient, p.subject, p.detail].filter(Boolean).join(" · ")}</p>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}
    </div>
  );
}
