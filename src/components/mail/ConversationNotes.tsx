import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Activity, Lock, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { describeEvent, memberHandles, NOTE_MAX, noteSegments, type ConversationEvent, type ConversationNote, type MailboxMember } from "@shared/collab";
import { errorMessage } from "@/lib/api";
import { useConversationActions } from "@/lib/collab";
import { longDate, relativeTime } from "@/lib/format";
import { Avatar, Button, cx, IconButton, Textarea } from "../ui/primitives";
import { useConfirm } from "../ui/overlay";
import { personName } from "./CollabControls";

/** Note text with links and @mentions. Rendered as React text nodes only, so a note can never inject markup. */
function NoteBody({ body, members, meId }: { body: string; members: MailboxMember[]; meId?: string }) {
  const byHandle = useMemo(() => memberHandles(members), [members]);
  const segments = useMemo(() => noteSegments(body, new Set(byHandle.keys())), [body, byHandle]);
  return (
    <p className="text-[13px] leading-relaxed break-words whitespace-pre-wrap text-fg">
      {segments.map((s, i) => {
        if (s.kind === "link") {
          return (
            <a key={i} href={s.href} target="_blank" rel="noopener noreferrer nofollow" className="text-accent-ink underline underline-offset-2">
              {s.text}
            </a>
          );
        }
        if (s.kind === "mention") {
          const m = byHandle.get(s.handle);
          return (
            <span key={i} title={m ? `${personName(m)} <${m.email}>` : undefined} className={cx("rounded px-0.5 font-medium", m?.id === meId ? "bg-accent text-accent-fg" : "bg-accent-soft text-accent-ink")}>
              {s.text}
            </span>
          );
        }
        return <span key={i}>{s.text}</span>;
      })}
    </p>
  );
}

export function NoteCard({ note, members, meId, mailboxId, threadId }: { note: ConversationNote; members: MailboxMember[]; meId?: string; mailboxId: string; threadId: string }) {
  const actions = useConversationActions(mailboxId, threadId);
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const author = note.author;

  const remove = async () => {
    if (!(await confirm({ title: "Delete this note?", body: "It will be removed for everyone on the mailbox.", confirmLabel: "Delete", danger: true }))) return;
    actions.deleteNote.mutate(note.id, { onSuccess: () => toast.success("Note deleted"), onError: (e) => toast.error(errorMessage(e)) });
  };

  return (
    <div className="group border-b border-line bg-warning-soft/60 px-5 py-3 sm:pl-[70px] relative">
      <div className="absolute top-3 left-5 max-sm:hidden">
        <Avatar name={author?.name} email={author?.email ?? "deleted@user"} color={author?.color} src={author?.avatarUrl} size={32} />
      </div>
      <div className="flex items-center gap-2 text-xs">
        <span className="font-semibold text-fg">{author ? personName(author) : "Former member"}</span>
        <span className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-1.5 py-px text-[11px] font-medium text-warning">
          <Lock className="size-3" /> Internal note
        </span>
        <span className="text-fg-faint" title={longDate(note.createdAt)}>
          {relativeTime(note.createdAt)}
          {note.editedAt && " · edited"}
        </span>
        <span className="ml-auto flex opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 max-md:opacity-100">
          {note.canEdit && !editing && (
            <IconButton size="sm" label="Edit note" onClick={() => setEditing(true)}>
              <Pencil className="size-3.5" />
            </IconButton>
          )}
          {note.canDelete && (
            <IconButton size="sm" label="Delete note" onClick={remove}>
              <Trash2 className="size-3.5" />
            </IconButton>
          )}
        </span>
      </div>
      <div className="mt-1">
        {editing ? (
          <NoteEditor
            members={members}
            initial={note.body}
            submitLabel="Save"
            pending={actions.editNote.isPending}
            onCancel={() => setEditing(false)}
            onSubmit={(body, reset) =>
              actions.editNote.mutate(
                { id: note.id, body },
                { onSuccess: () => (reset(), setEditing(false)), onError: (e) => toast.error(errorMessage(e)) },
              )
            }
          />
        ) : (
          <NoteBody body={note.body} members={members} meId={meId} />
        )}
      </div>
    </div>
  );
}

/** Compact activity line: "Dylan assigned this to Priya · 2h ago". */
export function EventLine({ event, meId }: { event: ConversationEvent; meId?: string }) {
  return (
    <div className="flex items-center gap-2 border-b border-line px-5 py-1.5 text-xs text-fg-muted sm:pl-[70px]">
      <Activity className="size-3.5 shrink-0 text-fg-faint" />
      <span className="min-w-0 truncate">{describeEvent(event, meId)}</span>
      <span className="shrink-0 text-fg-faint" title={longDate(event.createdAt)}>
        · {relativeTime(event.createdAt)}
      </span>
    </div>
  );
}

/** Add an internal note at the bottom of the conversation. */
export function NoteComposer({ members, mailboxId, threadId }: { members: MailboxMember[]; mailboxId: string; threadId: string }) {
  const actions = useConversationActions(mailboxId, threadId);
  return (
    <div className="px-5 pb-5 sm:pl-[70px]">
      <NoteEditor
        members={members}
        initial=""
        submitLabel="Add note"
        pending={actions.addNote.isPending}
        onSubmit={(body, reset) => actions.addNote.mutate(body, { onSuccess: reset, onError: (e) => toast.error(errorMessage(e)) })}
      />
    </div>
  );
}

const MENTION_AT_CARET = /(?<![\w@.])@([\w.+-]*)$/;

/** Plain-text note editor with @mention suggestions (↑/↓ to pick, Enter or Tab to insert, ⌘/Ctrl+Enter to save). */
function NoteEditor({
  members,
  initial,
  submitLabel,
  pending,
  onSubmit,
  onCancel,
}: {
  members: MailboxMember[];
  initial: string;
  submitLabel: string;
  pending: boolean;
  onSubmit: (body: string, reset: () => void) => void;
  onCancel?: () => void;
}) {
  const [text, setText] = useState(initial);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);

  const handles = useMemo(() => [...memberHandles(members)].map(([handle, m]) => ({ handle, m })), [members]);
  const suggestions = useMemo(() => {
    if (query === null) return [];
    const q = query.toLowerCase();
    return handles.filter(({ handle, m }) => handle.startsWith(q) || m.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q))).slice(0, 6);
  }, [handles, query]);

  const sync = (value: string, caret: number) => {
    const m = value.slice(0, caret).match(MENTION_AT_CARET);
    setQuery(m ? m[1] : null);
    setActive(0);
  };

  const insert = ({ handle }: { handle: string }) => {
    const el = ref.current;
    if (!el) return;
    const caret = el.selectionStart;
    const before = text.slice(0, caret).replace(MENTION_AT_CARET, `@${handle} `);
    const next = before + text.slice(caret);
    setText(next);
    setQuery(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  };

  const submit = () => {
    const body = text.trim();
    if (!body || body.length > NOTE_MAX || pending) return;
    onSubmit(body, () => setText(""));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Keep the mail list's single-key shortcuts from firing while typing.
    e.stopPropagation();
    if (suggestions.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insert(suggestions[active] ?? suggestions[0]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setQuery(null);
        return;
      }
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
    if (e.key === "Escape" && onCancel) onCancel();
  };

  return (
    <div className="relative">
      <Textarea
        ref={ref}
        value={text}
        maxLength={NOTE_MAX}
        rows={initial ? 3 : 2}
        placeholder="Add an internal note — only your team sees it. Type @ to mention someone."
        aria-label="Internal note"
        className="resize-y border-warning/40 bg-warning-soft/40 text-[13px] focus:border-warning focus:ring-warning-soft"
        onChange={(e) => (setText(e.target.value), sync(e.target.value, e.target.selectionStart))}
        onClick={(e) => sync(e.currentTarget.value, e.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setQuery(null), 150)}
      />
      {suggestions.length > 0 && (
        <div role="listbox" aria-label="Mention a teammate" className="absolute bottom-full left-0 z-30 mb-1 w-72 rounded-ui border border-line bg-raised p-1 shadow-ui-lg">
          {suggestions.map(({ handle, m }, i) => (
            <button
              key={m.id}
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => (e.preventDefault(), insert({ handle }))}
              onMouseEnter={() => setActive(i)}
              className={cx("flex w-full items-center gap-2 rounded-ui-sm px-2 py-1.5 text-left text-[13px]", i === active && "bg-muted")}
            >
              <Avatar name={m.name} email={m.email} color={m.color} src={m.avatarUrl} size={20} />
              <span className="min-w-0 flex-1 truncate">{personName(m)}</span>
              <span className="max-w-32 truncate text-xs text-fg-faint">@{handle}</span>
            </button>
          ))}
        </div>
      )}
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" onClick={submit} loading={pending} disabled={!text.trim()}>
          {submitLabel}
        </Button>
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={() => (setText(initial), onCancel())}>
            Cancel
          </Button>
        )}
        <span className={cx("ml-auto text-[11px]", text.length > NOTE_MAX - 300 ? "text-warning" : "text-fg-faint")}>
          {text.length > NOTE_MAX - 300 ? `${text.length}/${NOTE_MAX}` : "⌘/Ctrl + Enter to save"}
        </span>
      </div>
    </div>
  );
}
