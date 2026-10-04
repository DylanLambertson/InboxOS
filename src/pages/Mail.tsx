import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { Inbox, RefreshCw, Search, X, Trash2, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";
import type { Folder, MessageListItem, View } from "@shared/types";
import { api, errorMessage } from "@/lib/api";
import { useLabels, useMailboxes, useMe, useMessageAction, useMessages, useInvalidateMail, type BulkInput } from "@/lib/queries";
import { useBulkConversation, useMembers } from "@/lib/collab";
import { useDensity } from "@/lib/brand";
import { useWorkspace } from "@/lib/workspace";
import { CONVERSATION_STATUSES, type ConversationStatus } from "@shared/collab";
import { longDate, mailboxLabel } from "@/lib/format";
import { useShortcuts } from "@/lib/shortcuts";
import { useCompose } from "@/components/compose/ComposeProvider";
import { at } from "@/components/compose/ScheduleDialog";
import { COLLAB_NAV, FOLDER_NAV } from "@/components/layout/Sidebar";
import { BulkActions, type BulkCollab } from "@/components/mail/BulkActions";
import { MessageRow } from "@/components/mail/MessageRow";
import { ThreadView } from "@/components/mail/ThreadView";
import { Button, Checkbox, cx, EmptyState, IconButton, LoadError, Spinner } from "@/components/ui/primitives";
import { useConfirm } from "@/components/ui/overlay";

const EMPTY_COPY: Record<string, { title: string; body: string }> = {
  inbox: { title: "You're all caught up", body: "New messages will show up here." },
  starred: { title: "No starred messages", body: "Star messages to find them quickly later." },
  sent: { title: "Nothing sent yet", body: "Messages you send appear here with their delivery status." },
  drafts: { title: "No drafts", body: "Drafts save automatically while you write." },
  scheduled: { title: "Nothing scheduled", body: "Use the arrow next to Send to schedule a message." },
  archive: { title: "Archive is empty", body: "Archived messages are out of your inbox but still searchable." },
  spam: { title: "No spam", body: "Messages you report as spam land here." },
  trash: { title: "Trash is empty", body: "Deleted messages are removed permanently after the retention period." },
  assigned: { title: "Nothing assigned to you", body: "Conversations teammates assign to you show up here." },
  unassigned: { title: "Everything has an owner", body: "Inbox conversations nobody has taken yet show up here." },
  mentions: { title: "No mentions", body: "When a teammate @mentions you in a note, the conversation shows up here." },
};

const COLLAB_VIEWS = ["assigned", "unassigned", "mentions"];

export function MailPage() {
  const { mailboxId = "", view: rawView = "inbox", messageId } = useParams();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const rawStatus = params.get("status");
  const convStatus = (CONVERSATION_STATUSES as readonly string[]).includes(rawStatus ?? "") ? (rawStatus as ConversationStatus) : null;
  const navigate = useNavigate();
  const { data: boxes, isLoading: boxesLoading, error: boxesError, refetch: refetchBoxes } = useMailboxes();
  const { data: me } = useMe();
  const unified = mailboxId === "all" && !!boxes?.length;
  const mailbox = unified
    ? { id: "all", address: "", name: "All inboxes", displayName: "All inboxes", role: boxes!.some((b) => b.role !== "viewer") ? ("editor" as const) : ("viewer" as const) }
    : boxes?.find((b) => b.id === mailboxId);
  const boxById = useMemo(() => new Map((boxes ?? []).map((b) => [b.id, b])), [boxes]);
  const { data: labels = [] } = useLabels(unified ? undefined : mailbox?.id);
  const isLabel = rawView.startsWith("label:");
  const labelId = isLabel ? rawView.slice(6) : null;
  const view = (isLabel ? "all" : rawView) as View;
  const threads = (me?.preferences.conversationView ?? true) && !["drafts", "scheduled"].includes(view);
  const features = useWorkspace().data?.features;
  const collabOn = features?.collaboration !== false;
  const snoozeOn = features?.snooze !== false;
  const showStatusChips = collabOn && !["drafts", "scheduled", "sent"].includes(view);
  const listParams = mailbox ? { mailboxId: mailbox.id, view, label: labelId, q, threads, status: showStatusChips ? convStatus : null } : null;
  const list = useMessages(listParams);
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const action = useMessageAction();
  const bulkConv = useBulkConversation();
  const { data: members = [] } = useMembers(unified || !collabOn ? undefined : mailbox?.id);
  const compose = useCompose();
  const confirm = useConfirm();
  const invalidate = useInvalidateMail();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [focusIdx, setFocusIdx] = useState(0);
  const lastChecked = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [searchText, setSearchText] = useState(q);
  const compact = useDensity(me?.preferences.density) === "compact";
  const base = `/mail/${mailboxId}/${rawView}`;
  // Search and the status chip survive opening and closing messages.
  const keep = new URLSearchParams([...(q ? [["q", q]] : []), ...(convStatus ? [["status", convStatus]] : [])]).toString();
  const suffix = keep ? `?${keep}` : "";
  const folderForActions: Folder | "starred" | "all" | "unread" | "label" = isLabel ? "label" : COLLAB_VIEWS.includes(view) ? "all" : (view as Folder);
  const title = isLabel
    ? labels.find((l) => l.id === labelId)?.name ?? "Label"
    : [...FOLDER_NAV, ...COLLAB_NAV].find((f) => f.view === view)?.label ?? "Mail";

  useEffect(() => setChecked(new Set()), [mailboxId, rawView, q, convStatus]);
  useEffect(() => setSearchText(q), [q]);

  const open = useCallback(
    (m: MessageListItem) => {
      if (m.folder === "drafts") return compose.open({ mailboxId: m.mailboxId, draftId: m.id });
      navigate(`${base}/${m.id}${suffix}`);
    },
    [base, compose, navigate, suffix],
  );

  const onCheck = useCallback(
    (m: MessageListItem, v: boolean, shift: boolean) => {
      setChecked((prev) => {
        const next = new Set(prev);
        if (shift && lastChecked.current) {
          const a = items.findIndex((x) => x.id === lastChecked.current);
          const b = items.findIndex((x) => x.id === m.id);
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (items[i]) next.add(items[i].id);
        } else if (v) next.add(m.id);
        else next.delete(m.id);
        lastChecked.current = m.id;
        return next;
      });
    },
    [items],
  );

  const onStar = useCallback((m: MessageListItem) => action.mutate({ ids: [m.id], action: m.isStarred ? "unstar" : "star" }), [action]);

  const runBulk = (a: Omit<BulkInput, "ids">, ids = [...checked]) => {
    if (!ids.length) return;
    action.mutate(
      { ...a, ids, thread: threads },
      {
        onSuccess: (r) => {
          const n = r.count;
          const verb: Record<string, string> = {
            move: `moved to ${a.folder}`,
            restore: "restored",
            delete: "deleted",
            labelAdd: "labeled",
            labelRemove: "updated",
            snooze: `snoozed until ${a.until ? longDate(a.until) : "later"}`,
          };
          if (verb[a.action]) toast.success(`${n} message${n === 1 ? "" : "s"} ${verb[a.action]}`);
          if (messageId && ids.includes(messageId) && ["move", "restore", "delete", "snooze"].includes(a.action)) navigate(`${base}${suffix}`);
          setChecked(new Set());
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  const bulkCollab: BulkCollab = {
    members,
    meId: me?.id,
    onAssign: (assigneeId) =>
      bulkConv.mutate(
        { ids: [...checked], assigneeId },
        {
          onSuccess: (r) => (toast.success(`${r.count} conversation${r.count === 1 ? "" : "s"} ${assigneeId ? "assigned" : "unassigned"}`), setChecked(new Set())),
          onError: (e) => toast.error(errorMessage(e)),
        },
      ),
    onStatus: (status) =>
      bulkConv.mutate(
        { ids: [...checked], status },
        {
          onSuccess: (r) => (toast.success(`${r.count} conversation${r.count === 1 ? "" : "s"} marked ${status}`), setChecked(new Set())),
          onError: (e) => toast.error(errorMessage(e)),
        },
      ),
  };
  const setStatusChip = (s: ConversationStatus | null) => {
    const next = new URLSearchParams(params);
    if (s) next.set("status", s);
    else next.delete("status");
    setParams(next);
  };

  const emptyFolder = async () => {
    if (!(await confirm({ title: `Empty ${view}?`, body: "All messages in this folder will be permanently deleted.", confirmLabel: "Empty", danger: true }))) return;
    try {
      const r = await api.post<{ count: number; notice?: string }>("messages/empty", { mailboxId, folder: view });
      toast.success(`Deleted ${r.count} message${r.count === 1 ? "" : "s"}`);
      if (r.notice) toast.info(r.notice);
      invalidate();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const currentIdx = messageId ? items.findIndex((m) => m.id === messageId) : -1;
  const step = (dir: 1 | -1) => {
    if (messageId) {
      const next = items[currentIdx + dir];
      if (next) open(next);
    } else setFocusIdx((i) => Math.min(Math.max(0, i + dir), items.length - 1));
  };
  const afterAction = () => {
    const next = items[currentIdx + 1] ?? items[currentIdx - 1];
    navigate(next && next.id !== messageId ? `${base}/${next.id}${suffix}` : `${base}${suffix}`);
  };

  useEffect(() => {
    listRef.current?.querySelector(`[data-id="${items[focusIdx]?.id}"]`)?.scrollIntoView({ block: "nearest" });
  }, [focusIdx, items]);

  const target = () => (messageId ? [messageId] : checked.size ? [...checked] : items[focusIdx] ? [items[focusIdx].id] : []);
  const readOnly = mailbox?.role === "viewer";
  // In the unified view, act as the mailbox that owns the message.
  const ownerOf = (id: string | undefined) => (id ? items.find((m) => m.id === id)?.mailboxId : undefined) ?? (unified ? undefined : mailboxId);
  const canSendIn = (mb: string | undefined) => !!mb && boxById.get(mb)?.role !== "viewer" && boxById.has(mb);
  const composeBox = unified ? boxes?.find((b) => b.role !== "viewer")?.id : mailboxId;
  useShortcuts(
    {
      c: () => composeBox && canSendIn(composeBox) && compose.open({ mailboxId: composeBox }),
      "/": () => searchRef.current?.focus(),
      j: () => step(1),
      k: () => step(-1),
      o: () => items[focusIdx] && !messageId && open(items[focusIdx]),
      Enter: () => items[focusIdx] && !messageId && open(items[focusIdx]),
      u: () => messageId && navigate(`${base}${suffix}`),
      Escape: () => (messageId ? navigate(`${base}${suffix}`) : setChecked(new Set())),
      e: () => !readOnly && runBulk({ action: "move", folder: "archive" }, target()),
      "#": () => !readOnly && runBulk({ action: "move", folder: "trash" }, target()),
      "!": () => !readOnly && runBulk({ action: "move", folder: "spam" }, target()),
      b: () => !readOnly && snoozeOn && ["inbox", "archive", "all", "starred", "unread"].includes(view) && runBulk({ action: "snooze", until: at(1, 8).toISOString() }, target()),
      s: () => {
        const m = items.find((x) => x.id === target()[0]);
        if (m) onStar(m);
      },
      "shift+i": () => runBulk({ action: "read" }, target()),
      "shift+u": () => runBulk({ action: "unread" }, target()),
      r: () => messageId && canSendIn(ownerOf(messageId)) && compose.open({ mailboxId: ownerOf(messageId)!, sourceId: messageId, mode: "reply" }),
      a: () => messageId && canSendIn(ownerOf(messageId)) && compose.open({ mailboxId: ownerOf(messageId)!, sourceId: messageId, mode: "replyAll" }),
      f: () => messageId && canSendIn(ownerOf(messageId)) && compose.open({ mailboxId: ownerOf(messageId)!, sourceId: messageId, mode: "forward" }),
      "g i": () => navigate(`/mail/${mailboxId}/inbox`),
      "g s": () => navigate(`/mail/${mailboxId}/starred`),
      "g t": () => navigate(`/mail/${mailboxId}/sent`),
      "g d": () => navigate(`/mail/${mailboxId}/drafts`),
      "g a": () => navigate(`/mail/${mailboxId}/all`),
    },
    [items, focusIdx, messageId, checked, mailbox, base, suffix],
  );

  if (boxesLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (boxesError && !boxes) return <LoadError error={boxesError} onRetry={() => refetchBoxes()} />;
  if (!mailbox) {
    if (boxes?.length) return <Navigate to={`/mail/${boxes[0].id}/inbox`} replace />;
    return <EmptyState icon={<Inbox className="size-5" />} title="No mailboxes yet" body="An administrator needs to give you access to a mailbox before you can send or receive mail." />;
  }

  const allChecked = items.length > 0 && items.every((m) => checked.has(m.id));
  const anyUnread = [...checked].some((id) => !items.find((m) => m.id === id)?.isRead);
  const showRecipients = ["sent", "drafts", "scheduled"].includes(view);

  return (
    <div className="flex h-full min-w-0">
      {/* List pane */}
      <section className={cx("flex min-w-0 flex-col border-r border-line lg:w-[400px] lg:shrink-0 xl:w-[440px]", messageId ? "max-lg:hidden" : "w-full")}>
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3">
          <form
            className="relative flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              const v = searchText.trim();
              setParams(v ? { q: v } : {});
              if (messageId) navigate(`${base}${v ? `?q=${encodeURIComponent(v)}` : ""}`);
            }}
          >
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-faint" />
            <input
              ref={searchRef}
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && (e.currentTarget.blur(), e.stopPropagation())}
              placeholder={unified ? "Search all inboxes" : `Search ${mailboxLabel(mailbox)}`}
              aria-label="Search mail"
              className="h-9 w-full rounded-ui border border-transparent bg-muted pr-16 pl-8 text-[13px] outline-none placeholder:text-fg-faint focus:border-accent focus:bg-surface focus:ring-3 focus:ring-accent-soft"
            />
            <span className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center">
              {q && (
                <IconButton size="sm" label="Clear search" type="button" onClick={() => (setSearchText(""), setParams({}))}>
                  <X className="size-3.5" />
                </IconButton>
              )}
              <SearchHelp onPick={(s) => (setSearchText((t) => `${t} ${s}`.trim()), searchRef.current?.focus())} />
            </span>
          </form>
        </div>

        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line px-3">
          <Checkbox
            label="Select all"
            checked={allChecked}
            indeterminate={checked.size > 0 && !allChecked}
            onChange={(v) => setChecked(v ? new Set(items.map((m) => m.id)) : new Set())}
            className="mr-1"
          />
          {checked.size > 0 ? (
            <>
              <span className="mr-1 text-xs font-medium text-fg-muted">{checked.size} selected</span>
              <BulkActions folder={folderForActions} anyUnread={anyUnread} labels={labels} readOnly={readOnly} run={(a) => runBulk(a)} size="sm" collab={bulkCollab} />
            </>
          ) : (
            <>
              <span className="truncate text-[13px] font-semibold">
                {q ? "Search results" : title}
                {unified && !q && <span className="ml-1.5 font-normal text-fg-muted">· all inboxes</span>}
              </span>
              <IconButton size="sm" label="Refresh" onClick={() => list.refetch()} className="ml-1">
                <RefreshCw className={cx("size-3.5", list.isRefetching && "animate-spin")} />
              </IconButton>
              {(view === "trash" || view === "spam") && items.length > 0 && !readOnly && !q && !unified && (
                <Button size="xs" variant="ghost" className="ml-auto" icon={<Trash2 className="size-3.5" />} onClick={emptyFolder}>
                  Empty {view}
                </Button>
              )}
            </>
          )}
        </div>

        {showStatusChips && (
          <div role="radiogroup" aria-label="Filter by status" className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-3 py-1.5">
            {([null, ...CONVERSATION_STATUSES] as const).map((s) => (
              <button
                key={s ?? "all"}
                role="radio"
                aria-checked={convStatus === s}
                onClick={() => setStatusChip(s)}
                className={cx(
                  "h-6 shrink-0 rounded-full px-2.5 text-xs font-medium transition-colors",
                  convStatus === s ? "bg-accent-soft text-accent" : "text-fg-muted hover:bg-muted hover:text-fg",
                )}
              >
                {s ? s[0].toUpperCase() + s.slice(1) : "All"}
              </button>
            ))}
          </div>
        )}

        <div
          ref={listRef}
          role="listbox"
          aria-label="Messages"
          className="min-h-0 flex-1 overflow-y-auto"
          onScroll={(e) => {
            const el = e.currentTarget;
            if (el.scrollTop + el.clientHeight > el.scrollHeight - 400 && list.hasNextPage && !list.isFetchingNextPage) list.fetchNextPage();
          }}
        >
          {list.isLoading ? (
            <ListSkeleton />
          ) : list.error ? (
            <EmptyState title="Couldn't load messages" body={errorMessage(list.error)} action={<Button onClick={() => list.refetch()}>Try again</Button>} />
          ) : items.length === 0 ? (
            q ? (
              <EmptyState icon={<Search className="size-5" />} title="No results" body={`Nothing matched “${q}”. Try different words or fewer filters.`} />
            ) : (
              <EmptyState icon={<Inbox className="size-5" />} title={EMPTY_COPY[view]?.title ?? "No messages"} body={EMPTY_COPY[view]?.body} />
            )
          ) : (
            <>
              {items.map((m, i) => (
                <MessageRow
                  key={m.id}
                  m={m}
                  selected={m.id === messageId}
                  checked={checked.has(m.id)}
                  focused={i === focusIdx && !messageId}
                  compact={compact}
                  labels={labels}
                  mailboxTag={unified ? boxById.get(m.mailboxId) : undefined}
                  showRecipients={showRecipients}
                  onOpen={open}
                  onCheck={onCheck}
                  onStar={onStar}
                />
              ))}
              {list.isFetchingNextPage && (
                <div className="flex justify-center py-4">
                  <Spinner />
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {/* Reading pane */}
      <section className={cx("min-w-0 flex-1 bg-bg", !messageId && "max-lg:hidden")}>
        {messageId ? (
          <ThreadView
            key={messageId}
            messageId={messageId}
            mailboxes={boxes ?? []}
            onBack={() => navigate(`${base}${suffix}`)}
            onNavigate={step}
            onAfterAction={afterAction}
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <EmptyState icon={<Inbox className="size-5" />} title="No message selected" body="Pick a message to read it here. Press ? to see keyboard shortcuts." />
          </div>
        )}
      </section>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="animate-pulse">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex gap-3 border-b border-line px-3 py-3.5">
          <div className="size-8 rounded-full bg-muted" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-1/3 rounded bg-muted" />
            <div className="h-3 w-2/3 rounded bg-muted" />
            <div className="h-3 w-1/2 rounded bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}

const OPERATORS = [
  ["from:", "Sender name or address"],
  ["to:", "Recipient"],
  ["subject:", "Words in the subject"],
  ["has:attachment", "Has files attached"],
  ["is:unread", "Unread only"],
  ["is:starred", "Starred only"],
  ["in:sent", "In a folder (inbox, sent, archive…)"],
  ["label:", "Has a label"],
  ["after:2026-01-01", "On or after a date"],
  ["before:2026-02-01", "Before a date"],
];

function SearchHelp({ onPick }: { onPick: (s: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <IconButton size="sm" type="button" label="Search options" onClick={() => setOpen((o) => !o)}>
        <SlidersHorizontal className="size-3.5" />
      </IconButton>
      {open && (
        <div className="animate-in absolute top-full right-0 z-40 mt-2 w-80 rounded-ui border border-line bg-raised p-2 shadow-ui-lg">
          <p className="px-2 pt-1 pb-2 text-xs text-fg-muted">Combine words with filters:</p>
          {OPERATORS.map(([op, desc]) => (
            <button
              key={op}
              type="button"
              onClick={() => (onPick(op), setOpen(false))}
              className="flex w-full items-center justify-between gap-3 rounded-ui-sm px-2 py-1.5 text-left hover:bg-muted"
            >
              <code className="text-xs font-medium text-accent">{op}</code>
              <span className="truncate text-xs text-fg-muted">{desc}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
