import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, Download, ImageOff, Inbox, Mailbox, Paperclip, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { Address, MessageDetail, MessageStatus } from "@shared/types";
import { api, errorMessage } from "@/lib/api";
import { displayName, fileSize, fullAddress, longDate, shortDate } from "@/lib/format";
import { AttachmentChip } from "@/components/mail/AttachmentChip";
import { EmailFrame } from "@/components/mail/EmailFrame";
import { EVENT_LABELS, StatusBadge } from "@/components/mail/StatusBadge";
import { Badge, Button, Card, cx, EmptyState, Input, LoadError, PageHeader, Select, Spinner } from "@/components/ui/primitives";
import { Modal, Tabs, useConfirm } from "@/components/ui/overlay";
import { useAdminMailboxes } from "./MailboxAccess";
import { useCanManage } from "@/lib/queries";

type Scope = "all" | "inbound" | "outbound" | "unrouted" | "problems";
const ATT_BASE = "/api/admin/traffic/attachments";

interface TrafficItem {
  id: string;
  direction: "inbound" | "outbound";
  status: MessageStatus;
  folder: string;
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  snippet: string;
  hasAttachments: boolean;
  size: number;
  date: string;
  mailbox: { id: string; address: string; displayName: string; color: string } | null;
}

type TrafficDetail = MessageDetail & { mailbox: TrafficItem["mailbox"] };

function useDebounced<T>(v: T, ms = 300) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

function StatTile({ label, value, active, tone, onClick }: { label: string; value: number; active: boolean; tone?: "warning" | "danger"; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "rounded-ui-lg border bg-surface p-4 text-left shadow-ui-sm transition-colors hover:border-line-strong",
        active ? "border-accent ring-3 ring-accent-soft" : "border-line",
      )}
    >
      <p className="text-xs font-medium text-fg-muted">{label}</p>
      <p className={cx("mt-1 text-2xl font-semibold tracking-tight tabular-nums", value > 0 && tone === "warning" && "text-warning", value > 0 && tone === "danger" && "text-danger")}>
        {value.toLocaleString()}
      </p>
    </button>
  );
}

function MailboxTag({ mailbox }: { mailbox: TrafficItem["mailbox"] }) {
  if (!mailbox) {
    return (
      <Badge tone="warning">
        <AlertTriangle className="size-3" /> Unrouted
      </Badge>
    );
  }
  return (
    <span className="inline-flex max-w-40 items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[11px] text-fg-muted" title={mailbox.address}>
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: mailbox.color }} />
      <span className="truncate">{mailbox.displayName || mailbox.address}</span>
    </span>
  );
}

function DeliverPanel({ msg, onDone }: { msg: TrafficDetail; onDone: () => void }) {
  const { data: boxes = [] } = useAdminMailboxes();
  const qc = useQueryClient();
  const recipients = [...msg.to, ...msg.cc].map((a) => a.email);
  const [mailboxId, setMailboxId] = useState("");
  const [alias, setAlias] = useState(recipients[0] ?? "");
  const [addAlias, setAddAlias] = useState(true);
  const [busy, setBusy] = useState(false);
  const deliver = async () => {
    setBusy(true);
    try {
      await api.post(`admin/traffic/${msg.id}/deliver`, { mailboxId, ...(addAlias && alias ? { aliasAddress: alias } : {}) });
      qc.invalidateQueries({ queryKey: ["admin-traffic"] });
      qc.invalidateQueries({ queryKey: ["admin-mailboxes"] });
      toast.success(addAlias && alias ? `Delivered — future mail for ${alias} will go there too` : "Delivered to mailbox");
      onDone();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-ui border border-warning/30 bg-warning-soft p-4">
      <p className="flex items-center gap-2 text-[13px] font-medium text-warning">
        <AlertTriangle className="size-4" /> No mailbox exists for {recipients.join(", ") || "this address"}
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto]">
        <Select value={mailboxId} onChange={(e) => setMailboxId(e.target.value)} aria-label="Deliver to mailbox">
          <option value="">Choose a mailbox…</option>
          {boxes.filter((b) => b.isActive).map((b) => (
            <option key={b.id} value={b.id}>{b.displayName ? `${b.displayName} (${b.address})` : b.address}</option>
          ))}
        </Select>
        <Button variant="primary" icon={<Inbox className="size-4" />} disabled={!mailboxId} loading={busy} onClick={deliver}>
          Deliver
        </Button>
      </div>
      {recipients.length > 0 && (
        <label className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-fg">
          <input type="checkbox" checked={addAlias} onChange={(e) => setAddAlias(e.target.checked)} className="size-4 accent-[var(--accent)]" />
          Also send future mail for
          {recipients.length > 1 ? (
            <Select value={alias} onChange={(e) => setAlias(e.target.value)} className="h-7 w-auto text-[13px]">
              {recipients.map((r) => <option key={r}>{r}</option>)}
            </Select>
          ) : (
            <span className="font-medium">{alias}</span>
          )}
          to this mailbox
        </label>
      )}
    </div>
  );
}

function TrafficViewer({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: msg, isLoading, error } = useQuery({ queryKey: ["admin-traffic-msg", id], queryFn: () => api.get<TrafficDetail>(`admin/traffic/${id}`), staleTime: Infinity });
  const [allowRemote, setAllowRemote] = useState(false);
  const [blocked, setBlocked] = useState(0);
  const [headers, setHeaders] = useState(false);
  const confirm = useConfirm();
  const qc = useQueryClient();
  const editable = useCanManage();
  const visible = msg?.attachments.filter((a) => !a.inline || !(msg.html ?? "").includes(`cid:${a.contentId}`)) ?? [];

  return (
    <Modal open onClose={onClose} title={msg?.subject || (isLoading ? "Loading…" : "(no subject)")} width={860}>
      {isLoading ? (
        <Spinner />
      ) : error || !msg ? (
        <EmptyState title="Message not found" body={errorMessage(error)} />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {msg.direction === "inbound" ? <Badge><ArrowDownLeft className="size-3" /> Received</Badge> : <Badge><ArrowUpRight className="size-3" /> Sent</Badge>}
            <MailboxTag mailbox={msg.mailbox} />
            {msg.direction === "outbound" && <StatusBadge status={msg.status} />}
            <span className="ml-auto text-xs text-fg-muted">{longDate(msg.date)}</span>
          </div>

          <dl className="grid grid-cols-[56px_1fr] gap-x-3 gap-y-1 rounded-ui border border-line bg-subtle p-3 text-[13px]">
            <dt className="text-fg-muted">From</dt>
            <dd className="break-all">{fullAddress(msg.from)}</dd>
            <dt className="text-fg-muted">To</dt>
            <dd className="break-all">{msg.to.map(fullAddress).join(", ") || "—"}</dd>
            {msg.cc.length > 0 && (<><dt className="text-fg-muted">Cc</dt><dd className="break-all">{msg.cc.map(fullAddress).join(", ")}</dd></>)}
            {msg.bcc.length > 0 && (<><dt className="text-fg-muted">Bcc</dt><dd className="break-all">{msg.bcc.map(fullAddress).join(", ")}</dd></>)}
            {msg.sentBy && (<><dt className="text-fg-muted">By</dt><dd>{msg.sentBy.name}</dd></>)}
          </dl>

          {!msg.mailbox && msg.direction === "inbound" && editable && <DeliverPanel msg={msg} onDone={onClose} />}

          {msg.events.length > 0 && (
            <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
              {msg.events.map((e) => (
                <li key={e.id} title={e.detail ?? undefined}>
                  <span className="font-medium text-fg">{EVENT_LABELS[e.type] ?? e.type}</span> · {shortDate(e.createdAt)}
                </li>
              ))}
            </ol>
          )}

          {blocked > 0 && !allowRemote && (
            <div className="flex items-center gap-2 rounded-ui border border-line bg-subtle px-3 py-2 text-[13px] text-fg-muted">
              <ImageOff className="size-4" />
              <span className="flex-1">Remote images are hidden.</span>
              <Button size="xs" onClick={() => setAllowRemote(true)}>Show images</Button>
            </div>
          )}
          <div className="rounded-ui border border-line">
            <EmailFrame html={msg.html} text={msg.text} attachments={msg.attachments} allowRemote={allowRemote} onBlocked={setBlocked} attachmentBase={ATT_BASE} maxHeight={520} />
          </div>

          {visible.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {visible.map((a) => (
                <AttachmentChip key={a.id} attachment={a} base={ATT_BASE} onPreview={() => window.open(`${ATT_BASE}/${a.id}`, "_blank", "noopener")} />
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button size="sm" variant="ghost" onClick={() => setHeaders((h) => !h)}>{headers ? "Hide headers" : "Show headers"}</Button>
            <span className="text-xs text-fg-faint">Viewing this message was recorded in the audit log.</span>
            {!msg.mailbox && editable && (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto !text-danger hover:!bg-danger-soft"
                icon={<Trash2 className="size-3.5" />}
                onClick={async () => {
                  if (!(await confirm({ title: "Delete this message?", body: "It will be permanently removed.", confirmLabel: "Delete", danger: true }))) return;
                  try {
                    await api.del(`admin/traffic/${msg.id}`);
                    qc.invalidateQueries({ queryKey: ["admin-traffic"] });
                    toast.success("Deleted");
                    onClose();
                  } catch (e) {
                    toast.error(errorMessage(e));
                  }
                }}
              >
                Delete
              </Button>
            )}
          </div>
          {headers && (
            <div className="max-h-64 space-y-1 overflow-y-auto rounded-ui bg-subtle p-3 font-mono text-xs">
              {msg.messageIdHeader && <p><span className="text-fg-muted">Message-ID:</span> {msg.messageIdHeader}</p>}
              {Object.entries(msg.headers).map(([k, v]) => <p key={k} className="break-all"><span className="text-fg-muted">{k}:</span> {v}</p>)}
              {!Object.keys(msg.headers).length && <p className="font-sans text-fg-muted">No stored headers.</p>}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

export function AdminTraffic() {
  const [scope, setScope] = useState<Scope>("all");
  const [mailbox, setMailbox] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const dq = useDebounced(q);
  const { data: boxes = [] } = useAdminMailboxes();
  const { data: stats } = useQuery({ queryKey: ["admin-traffic", "stats"], queryFn: () => api.get<Record<"inbound" | "outbound" | "unrouted" | "problems", number>>("admin/traffic/stats"), refetchInterval: 30_000 });

  const list = useInfiniteQuery({
    queryKey: ["admin-traffic", scope, mailbox, dq],
    initialPageParam: "",
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ scope, mailbox, q: dq, cursor: pageParam, limit: "50" });
      return api.get<{ items: TrafficItem[]; nextCursor: string | null }>(`admin/traffic?${qs}`);
    },
    getNextPageParam: (l) => l.nextCursor ?? undefined,
    refetchInterval: 30_000,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const csv = `/api/admin/traffic?${new URLSearchParams({ scope, mailbox, q: dq, format: "csv" })}`;

  return (
    <div className="space-y-6">
      <PageHeader
        title="All traffic"
        description="Every email sent or received across your domain — every mailbox, plus mail for addresses that don't have one."
        actions={<a href={csv}><Button icon={<Download className="size-4" />}>Export CSV</Button></a>}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Received · 24h" value={stats?.inbound ?? 0} active={scope === "inbound"} onClick={() => setScope("inbound")} />
        <StatTile label="Sent · 24h" value={stats?.outbound ?? 0} active={scope === "outbound"} onClick={() => setScope("outbound")} />
        <StatTile label="Delivery problems · 24h" value={stats?.problems ?? 0} tone="danger" active={scope === "problems"} onClick={() => setScope("problems")} />
        <StatTile label="Unrouted (no mailbox)" value={stats?.unrouted ?? 0} tone="warning" active={scope === "unrouted"} onClick={() => setScope("unrouted")} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Tabs
          value={scope}
          onChange={setScope}
          tabs={[
            { value: "all", label: "All" },
            { value: "inbound", label: "Received" },
            { value: "outbound", label: "Sent" },
            { value: "unrouted", label: "Unrouted" },
            { value: "problems", label: "Problems" },
          ]}
        />
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-faint" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search sender, recipient, subject or content" className="pl-8" />
        </div>
        <Select value={mailbox} onChange={(e) => setMailbox(e.target.value)} className="w-56" aria-label="Filter by mailbox">
          <option value="">All mailboxes</option>
          {boxes.map((b) => <option key={b.id} value={b.id}>{b.address}</option>)}
        </Select>
      </div>

      <Card className="overflow-hidden">
        {list.isLoading ? (
          <div className="p-6"><Spinner /></div>
        ) : list.error && !rows.length ? (
          <LoadError error={list.error} onRetry={() => list.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState icon={<Mailbox className="size-5" />} title="No traffic" body={dq || scope !== "all" || mailbox ? "Nothing matches these filters." : "Mail will appear here as it's sent and received."} />
        ) : (
          <div className="divide-y divide-line">
            {rows.map((r) => (
              <button key={r.id} onClick={() => setOpen(r.id)} className="flex w-full items-center gap-4 px-5 py-3 text-left hover:bg-subtle">
                <span
                  className={cx("flex size-8 shrink-0 items-center justify-center rounded-full", r.direction === "inbound" ? "bg-accent-soft text-accent" : "bg-muted text-fg-muted")}
                  title={r.direction === "inbound" ? "Received" : "Sent"}
                >
                  {r.direction === "inbound" ? <ArrowDownLeft className="size-4" /> : <ArrowUpRight className="size-4" />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 truncate text-[13px]">
                    <span className="truncate font-medium">{displayName(r.from) || r.from.email}</span>
                    <span className="shrink-0 text-fg-faint">→</span>
                    <span className="truncate text-fg-muted">{[...r.to, ...r.cc].map((a) => a.email).join(", ") || "—"}</span>
                  </p>
                  <p className="truncate text-[13px] text-fg-muted">
                    <span className="text-fg">{r.subject || "(no subject)"}</span>
                    {r.snippet && <span className="text-fg-faint"> — {r.snippet}</span>}
                  </p>
                </div>
                <div className="hidden shrink-0 items-center gap-2 md:flex">
                  {r.hasAttachments && <Paperclip className="size-3.5 text-fg-faint" />}
                  {r.direction === "outbound" && <StatusBadge status={r.status} />}
                  <MailboxTag mailbox={r.mailbox} />
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
      {list.hasNextPage && (
        <div className="flex justify-center">
          <Button loading={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>Load more</Button>
        </div>
      )}
      {open && <TrafficViewer id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
