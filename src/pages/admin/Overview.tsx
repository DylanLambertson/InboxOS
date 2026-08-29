import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, CircleDashed, ArrowRight } from "lucide-react";
import { api } from "@/lib/api";
import { fileSize, relativeTime } from "@/lib/format";
import { Card, PageHeader, Section, Spinner, cx } from "@/components/ui/primitives";
import { EVENT_LABELS } from "@/components/mail/StatusBadge";
import { ActivityChart } from "./ActivityChart";

export interface OverviewData {
  usage: { today: number; month: number; dailyLimit: number; monthlyLimit: number };
  counts: { users: number; invited: number; mailboxes: number; messages: number; bytes: number; scheduled: number };
  series: { day: string; type: string; n: number }[];
  recentProblems: { id: string; type: string; detail: string | null; recipient: string | null; created_at: string; subject: string | null }[];
  provider: { apiKey: boolean; webhookSecret: boolean; google: boolean; webhookUrl: string };
}

function Meter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  const tone = pct >= 90 ? "bg-danger" : pct >= 70 ? "bg-warning" : "bg-accent";
  return (
    <Card className="p-5">
      <p className="text-xs font-medium text-fg-muted">{label}</p>
      <p className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums">
        {used.toLocaleString()}
        <span className="text-sm font-normal text-fg-muted"> / {limit ? limit.toLocaleString() : "∞"}</span>
      </p>
      {limit > 0 && (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted" role="meter" aria-valuenow={used} aria-valuemax={limit} aria-label={label}>
          <div className={cx("h-full rounded-full", tone)} style={{ width: `${pct}%` }} />
        </div>
      )}
      {limit > 0 && pct >= 90 && <p className="mt-2 flex items-center gap-1 text-xs text-danger"><AlertTriangle className="size-3" /> Near the limit</p>}
    </Card>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-5">
      <p className="text-xs font-medium text-fg-muted">{label}</p>
      <p className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-fg-muted">{hint}</p>}
    </Card>
  );
}

export function AdminOverview() {
  const { data, isLoading } = useQuery({ queryKey: ["admin-overview"], queryFn: () => api.get<OverviewData>("admin/overview"), refetchInterval: 60_000 });
  if (isLoading || !data) return <Spinner />;
  const checks = [
    { ok: data.provider.apiKey, label: "Resend API key", hint: "Needed to send and fetch received mail." },
    { ok: data.provider.webhookSecret, label: "Webhook signing secret", hint: "Needed to receive mail and delivery events." },
    { ok: data.provider.google, label: "Google sign-in", hint: "Optional." , optional: true },
  ];
  const ready = checks.filter((c) => !c.optional).every((c) => c.ok);

  return (
    <div className="space-y-6">
      <PageHeader title="Overview" description="Sending volume, quotas and system health." />

      {!ready && (
        <Link to="/admin/setup" className="flex items-center gap-3 rounded-ui-lg border border-warning/30 bg-warning-soft px-4 py-3 text-[13px] text-warning">
          <AlertTriangle className="size-4 shrink-0" />
          <span className="flex-1">Setup isn't finished — mail can't be sent or received until the provider is connected.</span>
          <ArrowRight className="size-4" />
        </Link>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Meter label="Sent today (UTC)" used={data.usage.today} limit={data.usage.dailyLimit} />
        <Meter label="Sent this month" used={data.usage.month} limit={data.usage.monthlyLimit} />
        <Stat label="Active users" value={String(data.counts.users)} hint={data.counts.invited ? `${data.counts.invited} invite${data.counts.invited > 1 ? "s" : ""} pending` : undefined} />
        <Stat label="Storage" value={fileSize(data.counts.bytes)} hint={`${data.counts.messages.toLocaleString()} messages · ${data.counts.mailboxes} mailboxes`} />
      </div>

      <Section title="Activity" description="Messages sent and received over the last 14 days.">
        <ActivityChart rows={data.series} />
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Connection status">
          <ul className="space-y-3">
            {checks.map((c) => (
              <li key={c.label} className="flex items-start gap-3">
                {c.ok ? <CheckCircle2 className="mt-0.5 size-4 text-success" /> : <CircleDashed className={cx("mt-0.5 size-4", c.optional ? "text-fg-faint" : "text-warning")} />}
                <div>
                  <p className="text-[13px] font-medium">
                    {c.label} <span className="font-normal text-fg-muted">— {c.ok ? "connected" : "not configured"}</span>
                  </p>
                  <p className="text-xs text-fg-muted">{c.hint}</p>
                </div>
              </li>
            ))}
          </ul>
        </Section>
        <Section
          title="Recent delivery problems"
          actions={
            <Link to="/admin/logs/delivery" className="text-xs text-fg-muted hover:text-fg">
              View log →
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
                    <AlertTriangle className="size-3.5 shrink-0 text-danger" />
                    <span className="font-medium">{EVENT_LABELS[p.type] ?? p.type}</span>
                    <span className="ml-auto shrink-0 text-xs text-fg-muted">{relativeTime(p.created_at)}</span>
                  </p>
                  <p className="truncate pl-5.5 text-xs text-fg-muted">{[p.recipient, p.subject, p.detail].filter(Boolean).join(" · ")}</p>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}
