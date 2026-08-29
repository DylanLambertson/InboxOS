import { useEffect, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Download, Search } from "lucide-react";
import { api } from "@/lib/api";
import { longDate, parseUserAgent } from "@/lib/format";
import { Badge, Button, Card, EmptyState, Input, PageHeader, Select, Spinner } from "@/components/ui/primitives";
import { Modal, Tabs } from "@/components/ui/overlay";
import { EVENT_LABELS } from "@/components/mail/StatusBadge";

interface EventRow {
  id: string;
  created_at: string;
  type: string;
  recipient: string | null;
  detail: string | null;
  resend_id: string | null;
  message_id: string | null;
  subject: string | null;
  from_addr: string | null;
  mailbox: string | null;
}

interface AuditRow {
  id: string;
  created_at: string;
  actor_email: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  ip: string | null;
  user_agent: string | null;
  meta: string;
}

const EVENT_TYPES = ["accepted", "sent", "delivered", "delivery_delayed", "bounced", "complained", "failed", "suppressed", "opened", "clicked", "received", "received.unrouted"];
const AUDIT_GROUPS = [
  ["", "All actions"],
  ["auth.", "Sign-ins"],
  ["user.", "Users"],
  ["mailbox.", "Mailboxes"],
  ["message.", "Messages"],
  ["settings.", "Settings"],
  ["template.", "Templates"],
];

const tone = (t: string) =>
  /bounced|complained|failed|suppressed|unrouted|login_failed|2fa_failed|deleted/.test(t) ? "danger"
  : /delayed|reset|disabled|revoked/.test(t) ? "warning"
  : /delivered|received|login$|enabled|accepted/.test(t) ? "success"
  : "neutral";

function useDebounced<T>(v: T, ms = 300) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export function AdminLogs() {
  const { kind } = useParams();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<{ kind: "event"; id: string } | { kind: "audit"; row: AuditRow } | null>(null);
  const dq = useDebounced(q);
  const isAudit = kind === "audit";
  useEffect(() => setFilter(""), [kind]);

  const list = useInfiniteQuery({
    queryKey: ["admin-logs", kind, dq, filter],
    initialPageParam: "",
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ q: dq, limit: "50", cursor: pageParam });
      qs.set(isAudit ? "action" : "type", filter);
      return api.get<{ items: (EventRow | AuditRow)[]; nextCursor: string | null }>(`admin/${isAudit ? "audit" : "events"}?${qs}`);
    },
    getNextPageParam: (l) => l.nextCursor ?? undefined,
    enabled: kind === "audit" || kind === "delivery",
  });
  if (kind !== "audit" && kind !== "delivery") return <Navigate to="/admin/logs/delivery" replace />;
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const csvHref = `/api/admin/${isAudit ? "audit" : "events"}?format=csv&q=${encodeURIComponent(dq)}&${isAudit ? "action" : "type"}=${encodeURIComponent(filter)}`;

  return (
    <div className="space-y-6">
      <PageHeader
        title={isAudit ? "Audit log" : "Delivery log"}
        description={isAudit ? "Every sign-in, permission change and administrative action." : "Every message accepted, delivered, bounced, opened or received — straight from the provider."}
        actions={
          <a href={csvHref}>
            <Button icon={<Download className="size-4" />}>Export CSV</Button>
          </a>
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={kind} onChange={(v) => navigate(`/admin/logs/${v}`)} tabs={[{ value: "delivery", label: "Delivery" }, { value: "audit", label: "Audit" }]} />
        <div className="relative min-w-60 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-faint" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={isAudit ? "Search by person, action, IP…" : "Search by recipient, subject, provider ID…"} className="pl-8" />
        </div>
        <Select value={filter} onChange={(e) => setFilter(e.target.value)} className="w-48">
          {isAudit ? (
            AUDIT_GROUPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)
          ) : (
            <>
              <option value="">All events</option>
              {EVENT_TYPES.map((t) => <option key={t} value={t}>{EVENT_LABELS[t] ?? t}</option>)}
            </>
          )}
        </Select>
      </div>

      <Card className="overflow-x-auto">
        {list.isLoading ? (
          <div className="p-6"><Spinner /></div>
        ) : rows.length === 0 ? (
          <EmptyState title="Nothing here yet" body={dq || filter ? "No entries match your filters." : "Entries appear as activity happens."} />
        ) : (
          <table className="w-full min-w-[760px] text-[13px]">
            <thead className="border-b border-line text-left text-xs text-fg-muted">
              {isAudit ? (
                <tr>
                  <th className="px-5 py-2.5 font-medium">Time</th>
                  <th className="px-3 py-2.5 font-medium">Action</th>
                  <th className="px-3 py-2.5 font-medium">Person</th>
                  <th className="px-3 py-2.5 font-medium">Target</th>
                  <th className="px-3 py-2.5 font-medium">IP / device</th>
                </tr>
              ) : (
                <tr>
                  <th className="px-5 py-2.5 font-medium">Time</th>
                  <th className="px-3 py-2.5 font-medium">Event</th>
                  <th className="px-3 py-2.5 font-medium">Recipient</th>
                  <th className="px-3 py-2.5 font-medium">Subject</th>
                  <th className="px-3 py-2.5 font-medium">Mailbox</th>
                </tr>
              )}
            </thead>
            <tbody className="divide-y divide-line">
              {isAudit
                ? (rows as AuditRow[]).map((r) => (
                    <tr key={r.id} className="cursor-pointer hover:bg-subtle" onClick={() => setOpen({ kind: "audit", row: r })}>
                      <td className="px-5 py-2.5 whitespace-nowrap text-fg-muted">{longDate(r.created_at)}</td>
                      <td className="px-3 py-2.5"><Badge tone={tone(r.action)}>{r.action}</Badge></td>
                      <td className="max-w-52 truncate px-3 py-2.5">{r.actor_email ?? "—"}</td>
                      <td className="px-3 py-2.5 text-fg-muted">{r.target_type ?? "—"}</td>
                      <td className="max-w-56 truncate px-3 py-2.5 text-fg-muted">{r.ip ?? "—"} · {parseUserAgent(r.user_agent)}</td>
                    </tr>
                  ))
                : (rows as EventRow[]).map((r) => (
                    <tr key={r.id} className="cursor-pointer hover:bg-subtle" onClick={() => setOpen({ kind: "event", id: r.id })}>
                      <td className="px-5 py-2.5 whitespace-nowrap text-fg-muted">{longDate(r.created_at)}</td>
                      <td className="px-3 py-2.5"><Badge tone={tone(r.type)}>{EVENT_LABELS[r.type] ?? r.type}</Badge></td>
                      <td className="max-w-52 truncate px-3 py-2.5">{r.recipient ?? "—"}</td>
                      <td className="max-w-64 truncate px-3 py-2.5">{r.subject ?? <span className="text-fg-faint">{r.detail ?? "—"}</span>}</td>
                      <td className="max-w-48 truncate px-3 py-2.5 text-fg-muted">{r.mailbox ?? "—"}</td>
                    </tr>
                  ))}
            </tbody>
          </table>
        )}
      </Card>
      {list.hasNextPage && (
        <div className="flex justify-center">
          <Button loading={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>Load more</Button>
        </div>
      )}

      {open?.kind === "event" && <EventDetail id={open.id} onClose={() => setOpen(null)} />}
      {open?.kind === "audit" && (
        <Modal open onClose={() => setOpen(null)} title={open.row.action} description={longDate(open.row.created_at)} width={620}>
          <dl className="grid grid-cols-[110px_1fr] gap-x-4 gap-y-2 text-[13px]">
            <dt className="text-fg-muted">Person</dt><dd>{open.row.actor_email ?? "—"}</dd>
            <dt className="text-fg-muted">Target</dt><dd className="break-all">{open.row.target_type ?? "—"} {open.row.target_id ?? ""}</dd>
            <dt className="text-fg-muted">IP</dt><dd>{open.row.ip ?? "—"}</dd>
            <dt className="text-fg-muted">Device</dt><dd className="break-all">{open.row.user_agent ?? "—"}</dd>
          </dl>
          <pre className="mt-4 max-h-80 overflow-auto rounded-ui bg-subtle p-3 font-mono text-xs">{JSON.stringify(JSON.parse(open.row.meta || "{}"), null, 2)}</pre>
        </Modal>
      )}
    </div>
  );
}

function EventDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data } = useQuery({ queryKey: ["admin-event", id], queryFn: () => api.get<Record<string, string | null>>(`admin/events/${id}`) });
  let payload = data?.payload ?? "{}";
  try {
    payload = JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    /* raw */
  }
  return (
    <Modal open onClose={onClose} title={data ? EVENT_LABELS[data.type ?? ""] ?? data.type ?? "Event" : "Event"} description={data?.created_at ? longDate(data.created_at) : undefined} width={680}>
      {!data ? (
        <Spinner />
      ) : (
        <>
          <dl className="grid grid-cols-[110px_1fr] gap-x-4 gap-y-2 text-[13px]">
            <dt className="text-fg-muted">Recipient</dt><dd className="break-all">{data.recipient ?? "—"}</dd>
            <dt className="text-fg-muted">Detail</dt><dd className="break-words">{data.detail ?? "—"}</dd>
            <dt className="text-fg-muted">Provider ID</dt><dd className="font-mono text-xs break-all">{data.resend_id ?? "—"}</dd>
          </dl>
          <p className="mt-4 mb-1.5 text-xs font-medium text-fg-muted">Raw webhook payload</p>
          <pre className="max-h-96 overflow-auto rounded-ui bg-subtle p-3 font-mono text-xs">{payload}</pre>
        </>
      )}
    </Modal>
  );
}
