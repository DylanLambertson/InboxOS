import { useEffect, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, MailX, Plus, Search, UserCheck } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { longDate, relativeTime } from "@/lib/format";
import { useCanManage } from "@/lib/queries";
import { Avatar, Badge, Button, Card, cx, EmptyState, Field, IconButton, Input, LoadError, PageHeader, Spinner } from "@/components/ui/primitives";
import { Modal, useConfirm } from "@/components/ui/overlay";

type Reason = "unsubscribed" | "bounced" | "complained" | "manual";

interface Entry {
  email: string;
  reason: Reason;
  detail: string | null;
  createdAt: string;
  name: string | null;
  company: string | null;
}
interface ListResponse {
  items: Entry[];
  total: number;
  counts: Record<Reason, number> & { last30Days: number };
}

const REASON: Record<Reason, { label: string; tone: "accent" | "warning" | "danger" | "neutral"; hint: string }> = {
  unsubscribed: { label: "Unsubscribed", tone: "accent", hint: "Used an unsubscribe link" },
  bounced: { label: "Bounced", tone: "warning", hint: "Address doesn't exist" },
  complained: { label: "Marked as spam", tone: "danger", hint: "Reported us as spam" },
  manual: { label: "Added by hand", tone: "neutral", hint: "Added by your team" },
};
const PAGE = 50;

/** Admin → Unsubscribes: everyone on the do-not-email list. */
export function AdminUnsubscribes() {
  const editable = useCanManage();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [reason, setReason] = useState<Reason | "">("");
  const [page, setPage] = useState(0);
  const [adding, setAdding] = useState(false);

  // Search as you type, without a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => (setQ(search.trim()), setPage(0)), 250);
    return () => clearTimeout(t);
  }, [search]);

  const params = new URLSearchParams({ limit: String(PAGE), offset: String(page * PAGE), ...(q ? { q } : {}), ...(reason ? { reason } : {}) });
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["admin-suppressions", q, reason, page],
    queryFn: () => api.get<ListResponse>(`admin/suppressions?${params}`),
    placeholderData: keepPreviousData,
  });

  const resubscribe = async (e: Entry) => {
    const ok = await confirm({
      title: `Take ${e.email} off the list?`,
      body:
        e.reason === "unsubscribed"
          ? "They asked not to be emailed. Only do this if they've asked to hear from you again."
          : e.reason === "bounced"
            ? "This address bounced. Sending to it again hurts your domain's reputation unless it's been fixed."
            : "They'll be able to receive outreach again.",
      confirmLabel: "Remove from list",
      danger: e.reason !== "manual",
    });
    if (!ok) return;
    try {
      await api.del(`admin/suppressions/${encodeURIComponent(e.email)}`);
      qc.invalidateQueries({ queryKey: ["admin-suppressions"] });
      toast.success(`${e.email} can be emailed again`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const exportUrl = `/api/admin/suppressions/export.csv?${new URLSearchParams({ ...(q ? { q } : {}), ...(reason ? { reason } : {}) })}`;
  const counts = data?.counts;
  const total = counts ? counts.unsubscribed + counts.bounced + counts.complained + counts.manual : 0;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE)) : 1;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Unsubscribes"
        description="Everyone who won't get outreach from you: people who unsubscribed, addresses that bounced, spam reports, and anyone added by hand. Sends to them are refused automatically."
        actions={
          <>
            <a href={exportUrl} download>
              <Button icon={<Download className="size-4" />}>Export CSV</Button>
            </a>
            {editable && (
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
                Add address
              </Button>
            )}
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Tile label="On the list" value={total} active={reason === ""} onClick={() => (setReason(""), setPage(0))} hint={counts ? `${counts.last30Days} in the last 30 days` : undefined} />
        {(Object.keys(REASON) as Reason[]).map((r) => (
          <Tile key={r} label={REASON[r].label} value={counts?.[r] ?? 0} active={reason === r} onClick={() => (setReason(reason === r ? "" : r), setPage(0))} hint={REASON[r].hint} />
        ))}
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-faint" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search email, name, company or reason" className="pl-9" aria-label="Search the list" />
          </div>
          {isFetching && <Spinner className="size-4" />}
          {data && <span className="text-xs text-fg-muted tabular-nums">{data.total.toLocaleString()} {data.total === 1 ? "person" : "people"}</span>}
        </div>

        {error ? (
          <div className="p-4">
            <LoadError error={error} onRetry={refetch} />
          </div>
        ) : isLoading ? (
          <div className="flex h-40 items-center justify-center">
            <Spinner />
          </div>
        ) : !data?.items.length ? (
          <EmptyState
            icon={<MailX className="size-5" />}
            title={q || reason ? "Nobody matches" : "Nobody has unsubscribed"}
            body={q || reason ? "Try a different search or filter." : "When someone unsubscribes, bounces or reports spam, they'll show up here."}
          />
        ) : (
          <ul className="divide-y divide-line">
            {data.items.map((e) => (
              <li key={e.email} className="flex items-center gap-3 px-4 py-3">
                <Avatar name={e.name ?? undefined} email={e.email} size={34} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="truncate text-[13px] font-medium">{e.name || e.email}</span>
                    <Badge tone={REASON[e.reason]?.tone ?? "neutral"}>{REASON[e.reason]?.label ?? e.reason}</Badge>
                  </div>
                  <p className="truncate text-xs text-fg-muted">
                    {e.name ? e.email : null}
                    {e.name && e.company ? " · " : null}
                    {e.company}
                    {(e.name || e.company) && e.detail ? " · " : null}
                    {e.detail}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-fg-muted tabular-nums" title={longDate(e.createdAt)}>
                  {relativeTime(e.createdAt)}
                </span>
                {editable && (
                  <IconButton label="Remove from the list" onClick={() => resubscribe(e)}>
                    <UserCheck className="size-4" />
                  </IconButton>
                )}
              </li>
            ))}
          </ul>
        )}

        {data && pages > 1 && (
          <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-xs text-fg-muted">
            <span>
              Page {page + 1} of {pages}
            </span>
            <div className="flex gap-2">
              <Button size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button size="sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>

      {adding && <AddDialog onClose={() => setAdding(false)} />}
    </div>
  );
}

function Tile({ label, value, hint, active, onClick }: { label: string; value: number; hint?: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        "rounded-ui border bg-surface p-4 text-left transition-colors hover:border-line-strong",
        active ? "border-accent ring-1 ring-accent" : "border-line",
      )}
    >
      <p className="text-xs font-medium text-fg-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value.toLocaleString()}</p>
      {hint && <p className="mt-0.5 truncate text-[11px] text-fg-faint">{hint}</p>}
    </button>
  );
}

function AddDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api.post("admin/suppressions", { email, note: note || undefined });
      qc.invalidateQueries({ queryKey: ["admin-suppressions"] });
      toast.success(`${email} won't receive outreach`);
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
      title="Add to the do-not-email list"
      description="For someone who asked by phone, in a reply, or anywhere else. Outreach to them will be refused."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())} onClick={submit}>
            Add
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Email address">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" autoFocus />
        </Field>
        <Field label="Note" hint="Optional, e.g. “Asked on the phone, 3 Oct”.">
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
        </Field>
      </div>
    </Modal>
  );
}
