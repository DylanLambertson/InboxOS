import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Download, Paperclip, Search, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import type { Address } from "@shared/types";
import { api, errorMessage } from "@/lib/api";
import { displayName, fileSize, shortDate } from "@/lib/format";
import { Badge, Button, Card, Checkbox, EmptyState, Field, Input, LoadError, Spinner } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlay";
import { useAdminMailboxes } from "./MailboxAccess";
import { TrafficViewer } from "./Traffic";
import { useIsOwner } from "./Compliance";

interface Criteria {
  q?: string;
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  after?: string;
  before?: string;
  hasAttachment?: boolean;
  mailboxIds?: string[];
}
interface Result {
  id: string;
  mailbox: { id: string; address: string; name: string };
  folder: string;
  from: Address;
  to: Address[];
  subject: string;
  hasAttachments: boolean;
  size: number;
  date: string;
}
interface Page {
  total: number | null;
  items: Result[];
  nextCursor: string | null;
}

const BASE = "admin/compliance/ediscovery";

/** Drop empty fields so the audit log records only what was actually searched. */
function clean(c: Criteria): Criteria {
  const out: Criteria = {};
  for (const [k, v] of Object.entries(c) as [keyof Criteria, Criteria[keyof Criteria]][]) {
    if (typeof v === "string" ? v.trim() : Array.isArray(v) ? v.length : v) (out as Record<string, unknown>)[k] = typeof v === "string" ? v.trim() : v;
  }
  return out;
}

/** Compliance → eDiscovery (owners only). */
export function Discovery() {
  const isOwner = useIsOwner();
  const [form, setForm] = useState<Criteria>({});
  const [criteria, setCriteria] = useState<Criteria | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [pickBoxes, setPickBoxes] = useState(false);
  const [exporting, setExporting] = useState(false);
  const { data: boxes = [] } = useAdminMailboxes();

  const results = useInfiniteQuery({
    queryKey: ["ediscovery", criteria],
    initialPageParam: "",
    enabled: !!criteria && isOwner,
    queryFn: ({ pageParam }) => api.post<Page>(`${BASE}/search`, { criteria: criteria!, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (l) => l.nextCursor ?? undefined,
    staleTime: Infinity,
  });

  if (!isOwner) {
    return (
      <Card>
        <EmptyState
          icon={<ShieldAlert className="size-5" />}
          title="Owners only"
          body="eDiscovery searches everyone's mail, so only organization owners can use it. Every search, message opened and export is recorded in the audit log."
        />
      </Card>
    );
  }

  const set = (k: keyof Criteria) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const rows = results.data?.pages.flatMap((p) => p.items) ?? [];
  const total = results.data?.pages[0]?.total ?? null;
  const chosen = form.mailboxIds ?? [];

  const exportZip = async () => {
    if (!criteria) return;
    setExporting(true);
    try {
      const r = await api.post<{ url: string; count: number; capped: boolean; maxMessages: number }>(`${BASE}/exports`, { criteria });
      if (r.capped) toast.warning(`Only the newest ${r.maxMessages} messages are included. Narrow the search to export the rest.`);
      else toast.success(`Exporting ${r.count} message${r.count === 1 ? "" : "s"}`);
      // Session-bound, short-lived link; the browser streams the ZIP straight to disk.
      window.location.assign(r.url);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setCriteria(clean(form));
          }}
        >
          <Field label="Search" hint="Same syntax as the mail search box, e.g. from:alice has:attachment “exact phrase”.">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-faint" />
              <Input value={form.q ?? ""} onChange={set("q")} className="pl-9" placeholder="Words in the message, or search operators" />
            </div>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="From">
              <Input value={form.from ?? ""} onChange={set("from")} placeholder="name or address" />
            </Field>
            <Field label="To, Cc or Bcc">
              <Input value={form.to ?? ""} onChange={set("to")} placeholder="name or address" />
            </Field>
            <Field label="Subject contains">
              <Input value={form.subject ?? ""} onChange={set("subject")} />
            </Field>
            <Field label="Body contains">
              <Input value={form.body ?? ""} onChange={set("body")} />
            </Field>
            <Field label="From date">
              <Input type="date" value={form.after ?? ""} onChange={set("after")} />
            </Field>
            <Field label="To date">
              <Input type="date" value={form.before ?? ""} onChange={set("before")} />
            </Field>
            <Field label="Mailboxes">
              <Button type="button" className="w-full justify-start" onClick={() => setPickBoxes(true)}>
                {chosen.length ? `${chosen.length} selected` : "All mailboxes"}
              </Button>
            </Field>
            <div className="flex items-end pb-2">
              <Checkbox checked={!!form.hasAttachment} onChange={(v) => setForm((f) => ({ ...f, hasAttachment: v }))} label="Has attachments" />
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <p className="text-xs text-fg-faint">Searches every folder, including Trash, Spam and drafts. Searches, opened messages and exports are audited.</p>
            <div className="flex gap-2">
              {criteria && rows.length > 0 && (
                <Button type="button" icon={<Download className="size-4" />} loading={exporting} onClick={exportZip}>
                  Export ZIP
                </Button>
              )}
              <Button type="submit" variant="primary" icon={<Search className="size-4" />}>
                Search
              </Button>
            </div>
          </div>
        </form>
      </Card>

      {criteria && (
        <Card className="overflow-hidden">
          {total !== null && (
            <div className="border-b border-line px-5 py-2.5 text-xs text-fg-muted tabular-nums">
              {total.toLocaleString()} message{total === 1 ? "" : "s"}
              {total > 500 && " · exports include the newest 500 (up to 100 MB)"}
            </div>
          )}
          {results.isLoading ? (
            <div className="p-6">
              <Spinner />
            </div>
          ) : results.error ? (
            <div className="p-4">
              <LoadError error={results.error} onRetry={() => results.refetch()} />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState icon={<Search className="size-5" />} title="No matches" body="Try fewer or broader terms." />
          ) : (
            <div className="divide-y divide-line">
              {rows.map((r) => (
                <button key={r.id} onClick={() => setOpen(r.id)} className="flex w-full items-center gap-4 px-5 py-3 text-left hover:bg-subtle">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 truncate text-[13px]">
                      <span className="truncate font-medium">{displayName(r.from) || r.from.email}</span>
                      <span className="shrink-0 text-fg-faint">→</span>
                      <span className="truncate text-fg-muted">{r.to.map((a) => a.email).join(", ") || "—"}</span>
                    </p>
                    <p className="truncate text-[13px]">{r.subject || "(no subject)"}</p>
                  </div>
                  <div className="hidden shrink-0 items-center gap-2 md:flex">
                    {r.hasAttachments && <Paperclip className="size-3.5 text-fg-faint" />}
                    <Badge>{r.folder}</Badge>
                    <span className="max-w-48 truncate text-xs text-fg-muted" title={r.mailbox.address}>
                      {r.mailbox.address}
                    </span>
                  </div>
                  <div className="w-20 shrink-0 text-right">
                    <p className="text-xs text-fg-muted tabular-nums">{shortDate(r.date)}</p>
                    <p className="text-[11px] text-fg-faint">{fileSize(r.size)}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>
      )}
      {results.hasNextPage && (
        <div className="flex justify-center">
          <Button loading={results.isFetchingNextPage} onClick={() => results.fetchNextPage()}>
            Load more
          </Button>
        </div>
      )}
      {open && <TrafficViewer id={open} base={BASE} readOnly onClose={() => setOpen(null)} />}
      {pickBoxes && (
        <Modal open onClose={() => setPickBoxes(false)} title="Search these mailboxes" footer={<Button variant="primary" onClick={() => setPickBoxes(false)}>Done</Button>}>
          <div className="space-y-3">
            <div className="flex gap-2">
              <Button size="xs" onClick={() => setForm((f) => ({ ...f, mailboxIds: [] }))}>
                All mailboxes
              </Button>
            </div>
            <div className="max-h-80 space-y-1.5 overflow-y-auto">
              {boxes.map((b) => (
                <Checkbox
                  key={b.id}
                  label={b.address}
                  checked={chosen.includes(b.id)}
                  onChange={(v) => setForm((f) => ({ ...f, mailboxIds: v ? [...(f.mailboxIds ?? []), b.id] : (f.mailboxIds ?? []).filter((x) => x !== b.id) }))}
                />
              ))}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
