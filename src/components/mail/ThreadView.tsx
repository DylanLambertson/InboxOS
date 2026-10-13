import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronUp, Clock, Forward, PenSquare, Printer, Reply, ReplyAll, X } from "lucide-react";
import { toast } from "sonner";
import type { MailboxSummary } from "@shared/types";
import { api, errorMessage } from "@/lib/api";
import { longDate } from "@/lib/format";
import { useInvalidateMail, useLabels, useMe, useMessageAction, useThread, type BulkInput } from "@/lib/queries";
import { useConversation, useMembers } from "@/lib/collab";
import { useFeature } from "@/lib/workspace";
import { useCompose } from "../compose/ComposeProvider";
import { Button, EmptyState, IconButton, Spinner } from "../ui/primitives";
import { BulkActions } from "./BulkActions";
import { ConversationControls, ReplyingBanner } from "./CollabControls";
import { EventLine, NoteCard, NoteComposer } from "./ConversationNotes";
import { MessageCard, printMessage } from "./MessageCard";

export function ThreadView({
  messageId,
  mailboxes,
  onBack,
  onNavigate,
  onAfterAction,
}: {
  messageId: string;
  mailboxes: MailboxSummary[];
  onBack: () => void;
  onNavigate: (dir: 1 | -1) => void;
  onAfterAction: () => void;
}) {
  const { data: thread, isLoading, error } = useThread(messageId);
  const { data: me } = useMe();
  const action = useMessageAction();
  const compose = useCompose();
  const invalidate = useInvalidateMail();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const markedFor = useRef<string | null>(null);
  const mailbox = mailboxes.find((b) => b.id === thread?.[0]?.mailboxId);
  const { data: labels = [] } = useLabels(mailbox?.id);
  const readOnly = !mailbox || mailbox.role === "viewer";
  // Assignments, notes and activity only while collaboration is on (Admin > Features).
  const collabOn = useFeature("collaboration");
  const { data: convData } = useConversation(collabOn ? mailbox?.id : undefined, thread?.[0]?.threadId);
  const conv = collabOn ? convData : undefined;
  const { data: members = [] } = useMembers(collabOn ? mailbox?.id : undefined);
  // Messages, internal notes and activity, interleaved by time.
  const timeline = useMemo(() => {
    const items: ({ at: string; kind: "note"; id: string } | { at: string; kind: "event"; id: string })[] = [
      ...(conv?.notes ?? []).map((n) => ({ at: n.createdAt, kind: "note" as const, id: n.id })),
      ...(conv?.events ?? []).map((e) => ({ at: e.createdAt, kind: "event" as const, id: e.id })),
    ];
    return items.sort((a, b) => a.at.localeCompare(b.at));
  }, [conv]);

  // Expand unread messages and the latest one; mark the conversation read.
  useEffect(() => {
    if (!thread?.length) return;
    const last = thread[thread.length - 1];
    setExpanded(new Set([last.id, ...thread.filter((m) => !m.isRead).map((m) => m.id)]));
    if (markedFor.current !== messageId && (me?.preferences.markReadOnOpen ?? true) && thread.some((m) => !m.isRead)) {
      markedFor.current = messageId;
      action.mutate({ ids: [messageId], action: "read", thread: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread, messageId]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (error || !thread?.length || !mailbox) {
    return <EmptyState title="Message not found" body="It may have been moved or deleted." action={<Button onClick={onBack}>Back</Button>} />;
  }

  const primary = thread.find((m) => m.id === messageId) ?? thread[thread.length - 1];
  const last = thread[thread.length - 1];
  const threadLabels = labels.filter((l) => thread.some((m) => m.labels.includes(l.id)));
  const lastInbound = [...thread].reverse().find((m) => m.direction === "inbound") ?? last;

  const run = (a: Omit<BulkInput, "ids">) => {
    action.mutate(
      { ...a, ids: [primary.id], thread: true },
      {
        onSuccess: () => {
          const msg: Record<string, string> = {
            move: `Moved to ${a.folder}`,
            restore: "Restored",
            delete: "Deleted forever",
            labelAdd: "Label added",
            labelRemove: "Label removed",
            unread: "Marked as unread",
            snooze: `Snoozed until ${a.until ? longDate(a.until) : "later"}`,
          };
          if (msg[a.action]) toast.success(msg[a.action]);
          if (["move", "restore", "delete", "unread", "snooze"].includes(a.action)) onAfterAction();
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  /** Timeline items in (from, to]; open-ended on either side. */
  const renderBetween = (from: string | null, to: string | null) =>
    conv &&
    timeline
      .filter((t) => (from === null || t.at > from) && (to === null || t.at <= to))
      .map((t) => {
        if (t.kind === "note") {
          const note = conv.notes.find((n) => n.id === t.id)!;
          return <NoteCard key={t.id} note={note} members={members} meId={me?.id} mailboxId={conv.mailboxId} threadId={conv.threadId} />;
        }
        const event = conv.events.find((e) => e.id === t.id)!;
        return <EventLine key={t.id} event={event} meId={me?.id} />;
      });

  const unschedule = async () => {
    try {
      await api.post(`drafts/${primary.id}/unschedule`);
      invalidate();
      toast.success("Schedule canceled — moved to Drafts");
      compose.open({ mailboxId: mailbox.id, draftId: primary.id });
      onAfterAction();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-2">
        <IconButton label="Back" shortcut="U" onClick={onBack} className="lg:hidden">
          <ArrowLeft className="size-4" />
        </IconButton>
        <IconButton label="Close" shortcut="Esc" onClick={onBack} className="max-lg:hidden">
          <X className="size-4" />
        </IconButton>
        <span className="mx-1 h-5 w-px bg-line" />
        <BulkActions folder={primary.folder} anyUnread={false} labels={labels} readOnly={readOnly} run={run} />
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton label="Print" onClick={() => printMessage(last)}>
            <Printer className="size-4" />
          </IconButton>
          <IconButton label="Newer" shortcut="K" onClick={() => onNavigate(-1)}>
            <ChevronUp className="size-4" />
          </IconButton>
          <IconButton label="Older" shortcut="J" onClick={() => onNavigate(1)}>
            <ChevronDown className="size-4" />
          </IconButton>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-5 pt-5 pb-3">
          <h1 className="text-lg leading-snug font-semibold tracking-tight break-words">{primary.subject || "(no subject)"}</h1>
          {threadLabels.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {threadLabels.map((l) => (
                <span key={l.id} className="group inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium" style={{ background: `${l.color}1f`, color: l.color }}>
                  {l.name}
                  {!readOnly && (
                    <button onClick={() => run({ action: "labelRemove", labelId: l.id })} aria-label={`Remove ${l.name}`} className="opacity-60 hover:opacity-100">
                      <X className="size-3" />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
          {conv && <ConversationControls info={conv} members={members} meId={me?.id} />}
        </div>

        {conv && <ReplyingBanner people={conv.replying} />}

        {primary.folder === "scheduled" && (
          <div className="mx-5 mb-3 flex flex-wrap items-center gap-3 rounded-ui border border-accent-ink/30 bg-accent-softer px-4 py-3 text-[13px]">
            <Clock className="size-4 text-accent-ink" />
            <span className="flex-1">Scheduled to send {primary.scheduledAt ? longDate(primary.scheduledAt) : "soon"}.</span>
            {!readOnly && (
              <Button size="sm" onClick={unschedule} icon={<PenSquare className="size-3.5" />}>
                Cancel & edit
              </Button>
            )}
          </div>
        )}

        <div className="border-t border-line">
          {thread.map((m, i) => (
            <Fragment key={m.id}>
              {/* Notes and activity that happened before this message (all of it, for the first one). */}
              {conv && renderBetween(i === 0 ? null : thread[i - 1].date, m.date)}
              <MessageCard
                m={m}
                readOnly={readOnly}
                expanded={expanded.has(m.id)}
                onToggle={() => setExpanded((s) => new Set(s).add(m.id))}
                onStar={() => action.mutate({ ids: [m.id], action: m.isStarred ? "unstar" : "star" })}
                onReply={(mode) => compose.open({ mailboxId: mailbox.id, sourceId: m.id, mode })}
              />
            </Fragment>
          ))}
          {conv && renderBetween(last.date, null)}
        </div>

        {!readOnly && primary.folder !== "scheduled" && primary.folder !== "drafts" && (
          <div className="flex flex-wrap gap-2 px-5 py-5 sm:pl-[70px]">
            <Button icon={<Reply className="size-4" />} onClick={() => compose.open({ mailboxId: mailbox.id, sourceId: lastInbound.id, mode: "reply" })}>
              Reply
            </Button>
            {lastInbound.to.length + lastInbound.cc.length > 1 && (
              <Button icon={<ReplyAll className="size-4" />} onClick={() => compose.open({ mailboxId: mailbox.id, sourceId: lastInbound.id, mode: "replyAll" })}>
                Reply all
              </Button>
            )}
            <Button icon={<Forward className="size-4" />} onClick={() => compose.open({ mailboxId: mailbox.id, sourceId: last.id, mode: "forward" })}>
              Forward
            </Button>
          </div>
        )}
        {conv?.canWrite && <NoteComposer members={members} mailboxId={conv.mailboxId} threadId={conv.threadId} />}
      </div>
    </div>
  );
}
