import { useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { toast } from "sonner";
import { SUBSCRIBABLE_EVENTS, WEBHOOK_EVENTS } from "@shared/webhooks";
import { api, errorMessage } from "@/lib/api";
import { longDate, relativeTime } from "@/lib/format";
import { useCanManage } from "@/lib/queries";
import { Badge, Button, EmptyState, LoadError, Select, Spinner } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlay";

export interface Delivery {
  id: string;
  endpointId: string;
  eventType: string;
  eventId: string;
  status: "pending" | "succeeded" | "failed";
  attempts: number;
  nextAttemptAt: string | null;
  responseStatus: number | null;
  responseMs: number | null;
  error: string | null;
  createdAt: string;
  deliveredAt: string | null;
  payload?: string;
  responseExcerpt?: string | null;
}

export interface AttemptResult {
  status: "succeeded" | "pending" | "failed";
  responseStatus: number | null;
  responseMs: number | null;
  error: string | null;
}

export function StatusBadge({ d }: { d: Pick<Delivery, "status" | "nextAttemptAt"> }) {
  if (d.status === "succeeded") return <Badge tone="success">Delivered</Badge>;
  if (d.status === "failed") return <Badge tone="danger">Failed</Badge>;
  return <Badge tone="warning">{d.nextAttemptAt ? `Retry ${relativeTime(d.nextAttemptAt)}` : "Sending"}</Badge>;
}

/** Toast for a test or redelivery result. */
export function reportAttempt(r: AttemptResult | null, what: string) {
  if (!r) return toast.info(`${what} queued.`);
  if (r.status === "succeeded") toast.success(`${what} delivered (HTTP ${r.responseStatus}, ${r.responseMs} ms).`);
  else toast.error(`${what} failed: ${r.error ?? "no response"}.${r.status === "pending" ? " It will be retried." : ""}`);
}

const pretty = (s: string | null | undefined) => {
  if (!s) return "";
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
};

function DeliveryDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const editable = useCanManage();
  const [busy, setBusy] = useState(false);
  const { data: d, error } = useQuery({ queryKey: ["admin-webhook-delivery", id], queryFn: () => api.get<Delivery>(`admin/webhooks/deliveries/${id}`) });
  const redeliver = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ result: AttemptResult | null }>(`admin/webhooks/deliveries/${id}/redeliver`);
      reportAttempt(r.result, "Redelivery");
      qc.invalidateQueries({ queryKey: ["admin-webhook-deliveries"] });
      qc.invalidateQueries({ queryKey: ["admin-webhooks"] });
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={d ? d.eventType : "Delivery"}
      description={d ? longDate(d.createdAt) : undefined}
      width={720}
      footer={
        <>
          {editable && d && (
            <Button icon={<RotateCw className="size-4" />} loading={busy} onClick={redeliver}>
              Redeliver
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>Close</Button>
        </>
      }
    >
      {error ? (
        <LoadError error={error} />
      ) : !d ? (
        <Spinner />
      ) : (
        <div className="space-y-4">
          <dl className="grid grid-cols-[130px_1fr] gap-x-4 gap-y-1.5 text-[13px]">
            <dt className="text-fg-muted">Status</dt><dd><StatusBadge d={d} /></dd>
            <dt className="text-fg-muted">webhook-id</dt><dd className="font-mono text-xs break-all">{d.eventId}</dd>
            <dt className="text-fg-muted">Attempts</dt><dd>{d.attempts}</dd>
            <dt className="text-fg-muted">Response</dt><dd>{d.responseStatus ? `HTTP ${d.responseStatus}` : "—"}{d.responseMs !== null && ` · ${d.responseMs} ms`}</dd>
            {d.error && (<><dt className="text-fg-muted">Error</dt><dd className="text-danger">{d.error}</dd></>)}
            {d.deliveredAt && (<><dt className="text-fg-muted">Delivered</dt><dd>{longDate(d.deliveredAt)}</dd></>)}
            {d.nextAttemptAt && (<><dt className="text-fg-muted">Next attempt</dt><dd>{longDate(d.nextAttemptAt)}</dd></>)}
          </dl>
          <div>
            <p className="mb-1.5 text-xs font-medium text-fg-muted">Request body</p>
            <pre className="max-h-72 overflow-auto rounded-ui bg-subtle p-3 font-mono text-xs">{pretty(d.payload)}</pre>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium text-fg-muted">Response (first 1,000 characters)</p>
            <pre className="max-h-48 overflow-auto rounded-ui bg-subtle p-3 font-mono text-xs whitespace-pre-wrap">{d.responseExcerpt || "(empty)"}</pre>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** One endpoint's delivery log, newest first, with status and event filters. */
export function Deliveries({ endpointId }: { endpointId: string }) {
  const [status, setStatus] = useState("");
  const [event, setEvent] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const list = useInfiniteQuery({
    queryKey: ["admin-webhook-deliveries", endpointId, status, event],
    initialPageParam: "",
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ status, event, cursor: pageParam, limit: "30" });
      return api.get<{ items: Delivery[]; nextCursor: string | null }>(`admin/webhooks/${endpointId}/deliveries?${qs}`);
    },
    getNextPageParam: (l) => l.nextCursor ?? undefined,
    refetchInterval: 15_000,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="h-8 w-40 text-[13px]" aria-label="Status">
          <option value="">All results</option>
          <option value="succeeded">Delivered</option>
          <option value="pending">Retrying</option>
          <option value="failed">Failed</option>
        </Select>
        <Select value={event} onChange={(e) => setEvent(e.target.value)} className="h-8 w-52 text-[13px]" aria-label="Event">
          <option value="">All events</option>
          <option value="ping">Test events</option>
          {SUBSCRIBABLE_EVENTS.map((k) => (
            <option key={k} value={k}>{WEBHOOK_EVENTS[k].label}</option>
          ))}
        </Select>
      </div>
      {list.isLoading ? (
        <Spinner />
      ) : list.error ? (
        <LoadError error={list.error} onRetry={() => list.refetch()} />
      ) : !rows.length ? (
        <EmptyState title="No deliveries yet" body={status || event ? "Nothing matches these filters." : "Send a test event to see one here."} />
      ) : (
        <div className="overflow-x-auto rounded-ui border border-line">
          <table className="w-full min-w-[620px] text-[13px]">
            <thead className="text-left text-xs text-fg-muted">
              <tr className="border-b border-line">
                <th className="px-3 py-2 font-medium">Event</th>
                <th className="px-3 py-2 font-medium">Result</th>
                <th className="px-3 py-2 font-medium">Response</th>
                <th className="px-3 py-2 font-medium">Attempts</th>
                <th className="px-3 py-2 font-medium">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((d) => (
                <tr key={d.id} tabIndex={0} className="cursor-pointer hover:bg-subtle focus-visible:bg-subtle focus-visible:outline-none" onClick={() => setOpen(d.id)} onKeyDown={(e) => e.key === "Enter" && setOpen(d.id)}>
                  <td className="px-3 py-2 font-mono text-xs">{d.eventType}</td>
                  <td className="px-3 py-2"><StatusBadge d={d} /></td>
                  <td className="max-w-56 truncate px-3 py-2 text-fg-muted">{d.responseStatus ? `HTTP ${d.responseStatus} · ${d.responseMs} ms` : d.error ?? "—"}</td>
                  <td className="px-3 py-2 tabular-nums text-fg-muted">{d.attempts}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-fg-muted">{relativeTime(d.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.hasNextPage && (
        <div className="flex justify-center">
          <Button size="sm" loading={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>Load more</Button>
        </div>
      )}
      {open && <DeliveryDetail id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
