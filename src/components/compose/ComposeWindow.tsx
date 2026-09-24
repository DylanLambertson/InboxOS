import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent } from "@tiptap/react";
import {
  AlertTriangle,
  ChevronDown,
  Clock,
  FileText,
  Flag,
  Maximize2,
  Minimize2,
  Minus,
  MoreHorizontal,
  Paperclip,
  Receipt,
  Send,
  Trash2,
  Type,
  X,
  Save,
} from "lucide-react";
import { toast } from "sonner";
import { mailDomains } from "@shared/brand";
import { api, errorMessage } from "@/lib/api";
import { useBrand } from "@/lib/brand";
import { useMailboxes, useMe, useTemplates } from "@/lib/queries";
import { useReplyingPresence } from "@/lib/collab";
import { useQueryClient } from "@tanstack/react-query";
import { EmailFrame } from "../mail/EmailFrame";
import { AttachmentChip } from "../mail/AttachmentChip";
import { Button, cx, IconButton, Spinner } from "../ui/primitives";
import { Menu, useConfirm } from "../ui/overlay";
import { EditorToolbar, useMailEditor } from "./Editor";
import { RecipientInput } from "./RecipientInput";
import { ScheduleDialog } from "./ScheduleDialog";
import { useDraft, type ComposeRequest } from "./useDraft";

interface Props {
  req: ComposeRequest;
  minimized: boolean;
  defaultFullscreen: boolean;
  onToggleMinimize: () => void;
  onClose: () => void;
  onSend: (draftId: string, mailboxId: string, scheduledAt?: string | null) => void;
}

export function ComposeWindow({ req, minimized, defaultFullscreen, onToggleMinimize, onClose, onSend }: Props) {
  const { data: me } = useMe();
  const { data: boxes = [] } = useMailboxes();
  const box = boxes.find((b) => b.id === req.mailboxId);
  const signature = box?.signatureHtml || me?.signatureHtml || "";
  const draft = useDraft(req, signature);
  const { state } = draft;
  // Teammates looking at this conversation see "<you> is replying…" while this is open.
  useReplyingPresence(req.mode !== "forward" ? req.sourceId : undefined);

  if (draft.loadError) {
    return (
      <Shell minimized={false} fullscreen={false} title="Couldn't open draft" onClose={onClose} onToggleMinimize={onToggleMinimize}>
        <div className="p-6 text-[13px] text-danger">{draft.loadError}</div>
      </Shell>
    );
  }
  if (!state) {
    return (
      <Shell minimized={minimized} fullscreen={false} title="Loading…" onClose={onClose} onToggleMinimize={onToggleMinimize}>
        <div className="flex h-60 items-center justify-center">
          <Spinner />
        </div>
      </Shell>
    );
  }
  return <ComposeBody draft={draft} minimized={minimized} defaultFullscreen={defaultFullscreen} onToggleMinimize={onToggleMinimize} onClose={onClose} onSend={onSend} />;
}

function ComposeBody({
  draft,
  minimized,
  defaultFullscreen,
  onToggleMinimize,
  onClose,
  onSend,
}: Omit<Props, "req"> & { draft: ReturnType<typeof useDraft> }) {
  const state = draft.state!;
  const { data: boxes = [] } = useMailboxes();
  const { data: templates = [] } = useTemplates();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [fullscreen, setFullscreen] = useState(defaultFullscreen);
  const [showCc, setShowCc] = useState(state.cc.length > 0);
  const [showBcc, setShowBcc] = useState(state.bcc.length > 0);
  const [showToolbar, setShowToolbar] = useState(true);
  const [showQuote, setShowQuote] = useState(state.mode === "forward");
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);

  const insertInlineImage = async (file: File) => {
    const info = await draft.upload(file, true);
    if (info) editor?.chain().focus().setImage({ src: `/api/attachments/${info.id}`, alt: info.filename }).run();
    else toast.error("Couldn't upload the image.");
  };

  const editor = useMailEditor({
    content: state.html,
    autofocus: state.mode !== "new" || state.to.length > 0,
    onUpdate: (html) => draft.update({ html }),
    onPasteImage: insertInlineImage,
  });

  const brand = useBrand();
  const domains = useMemo(() => mailDomains(brand), [brand]);
  // One identity per address, except that the same name on several mail domains
  // (hello@a, hello@b) is a single identity whose domain is picked with the switch.
  const identities = useMemo(
    () =>
      boxes
        .filter((b) => b.role !== "viewer")
        .flatMap((b) => {
          const groups = new Map<string, string[]>();
          for (const addr of [b.address, ...b.aliases].map((a) => a.toLowerCase())) {
            const [local, domain] = splitAddress(addr);
            const key = domains.includes(domain) ? local : addr;
            groups.set(key, [...(groups.get(key) ?? []), addr]);
          }
          return [...groups.values()].map((addrs) => ({
            mailboxId: b.id,
            name: b.displayName,
            addresses: addrs.sort((x, y) => domainRank(domains, x) - domainRank(domains, y)),
          }));
        }),
    [boxes, domains],
  );
  const currentFrom = (state.fromAddress || boxes.find((b) => b.id === state.mailboxId)?.address || "").toLowerCase();
  const currentIdentity = identities.find((i) => i.mailboxId === state.mailboxId && i.addresses.includes(currentFrom));
  const domainChoices = currentIdentity && currentIdentity.addresses.length > 1 ? currentIdentity.addresses : [];
  // With the domain switch showing, the From text only needs the name part ("hello@").
  const fromLabel = domainChoices.length ? `${splitAddress(currentFrom)[0]}@` : currentFrom;
  const pickFrom = (mailboxId: string, address: string) => {
    draft.update({ mailboxId, fromAddress: address });
    if (domainChoices.length) rememberSendDomain(splitAddress(address)[1]);
  };

  // New messages start on the domain the user last sent from.
  useEffect(() => {
    if (state.mode !== "new" || state.fromAddress || !currentIdentity) return;
    const preferred = currentIdentity.addresses.find((a) => splitAddress(a)[1] === lastSendDomain());
    if (preferred && preferred !== currentFrom) draft.update({ fromAddress: preferred });
  }, [currentIdentity]);
  const title = state.subject || (state.mode === "forward" ? "Forward" : state.mode === "new" ? "New message" : "Reply");
  const recipients = state.to.length + state.cc.length + state.bcc.length;

  const addFiles = (files: FileList | File[]) => [...files].forEach((f) => draft.upload(f));

  const send = async (scheduledAt?: string) => {
    if (!recipients) return toast.error("Add at least one recipient.");
    if (draft.uploading) return toast.error("Wait for attachments to finish uploading.");
    const bad = [...state.to, ...state.cc, ...state.bcc].find((a) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email));
    if (bad) return toast.error(`"${bad.email}" isn't a valid email address.`);
    if (!state.subject.trim() && !(await confirm({ title: "Send without a subject?", confirmLabel: "Send anyway" }))) return;
    const text = editor?.getText() ?? "";
    const visibleAttachments = state.attachments.filter((a) => !a.inline);
    if (/\b(attached|attachment|enclosed)\b/i.test(text) && !visibleAttachments.length) {
      const ok = await confirm({ title: "Did you forget an attachment?", body: "Your message mentions an attachment, but nothing is attached.", confirmLabel: "Send anyway" });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const saved = await draft.flush();
      onSend(saved.id, saved.mailboxId, scheduledAt ?? null);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    const hasContent = recipients || state.subject || (editor?.getText().trim().length ?? 0) > 3;
    if (hasContent && !(await confirm({ title: "Discard this draft?", body: "This can't be undone.", confirmLabel: "Discard", danger: true }))) return;
    if (state.id) {
      try {
        await api.del(`drafts/${state.id}`);
      } catch {
        /* already gone */
      }
    }
    qc.invalidateQueries({ queryKey: ["messages"] });
    onClose();
  };

  const closeAndSave = async () => {
    const hasContent = recipients || state.subject || (editor?.getText().trim().length ?? 0) > 0 || state.attachments.length;
    if (hasContent || state.id) {
      try {
        await draft.flush();
        toast("Draft saved", { duration: 2000 });
      } catch (e) {
        toast.error(`Couldn't save draft: ${errorMessage(e)}`);
        return;
      }
    }
    onClose();
  };

  const saveAsTemplate = async () => {
    const name = window.prompt("Template name", state.subject || "Untitled template");
    if (!name) return;
    try {
      await api.post("templates", { name, subject: state.subject, html: editor?.getHTML() ?? state.html, scope: "personal" });
      qc.invalidateQueries({ queryKey: ["templates"] });
      toast.success("Template saved");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  // Keyboard: ⌘/Ctrl+Enter sends; ⌘⇧C / ⌘⇧B reveal Cc/Bcc.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "Enter") (e.preventDefault(), send());
      if (mod && e.shiftKey && e.key.toLowerCase() === "c") (e.preventDefault(), setShowCc(true));
      if (mod && e.shiftKey && e.key.toLowerCase() === "b") (e.preventDefault(), setShowBcc(true));
      if (e.key === "Escape" && !fullscreen) (e.stopPropagation(), onToggleMinimize());
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  });

  const statusText =
    draft.status === "saving" ? "Saving…" : draft.status === "saved" ? "Saved" : draft.status === "error" ? "Not saved" : draft.status === "dirty" ? "Editing" : "";

  return (
    <Shell
      minimized={minimized}
      fullscreen={fullscreen}
      title={title}
      onClose={closeAndSave}
      onToggleMinimize={onToggleMinimize}
      onToggleFullscreen={() => setFullscreen((f) => !f)}
      rootRef={root}
    >
      <div
        className="relative flex min-h-0 flex-1 flex-col"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) (e.preventDefault(), setDragging(true));
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        {state.error && (
          <div className="flex items-start gap-2 border-b border-line bg-danger-soft px-3 py-2 text-[13px] text-danger">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>Last attempt failed: {state.error}</span>
          </div>
        )}

        {(identities.length > 1 || domainChoices.length > 0) && (
          <div className="flex h-10 items-center gap-2 border-b border-line px-3">
            <span className="w-9 shrink-0 text-[13px] text-fg-muted">From</span>
            {identities.length > 1 ? (
              <Menu
                width={320}
                items={identities.map((i) => {
                  // Keep the chosen domain when switching mailboxes, if the other mailbox has it.
                  const addr = i.addresses.find((a) => splitAddress(a)[1] === splitAddress(currentFrom)[1]) ?? i.addresses[0];
                  return {
                    label: i.name ? `${i.name} <${addr}>` : addr,
                    hint: i.addresses.length > 1 ? `${i.addresses.length} domains` : undefined,
                    checked: i === currentIdentity,
                    onSelect: () => pickFrom(i.mailboxId, addr),
                  };
                })}
                trigger={(p) => (
                  <button {...p} className="flex min-w-0 items-center gap-1 rounded px-1 text-[13px] hover:bg-muted">
                    <span className="truncate">{fromLabel}</span>
                    <ChevronDown className="size-3.5 text-fg-faint" />
                  </button>
                )}
              />
            ) : (
              <span className="min-w-0 truncate px-1 text-[13px]">{fromLabel}</span>
            )}
            {domainChoices.length > 0 && (
              <DomainSwitch
                className="-ml-1 min-w-0"
                options={domainChoices}
                value={currentFrom}
                onChange={(addr) => pickFrom(state.mailboxId, addr)}
              />
            )}
          </div>
        )}

        <RecipientInput
          label="To"
          value={state.to}
          onChange={(to) => draft.update({ to })}
          autoFocus={state.mode === "new" && !state.to.length}
          trailing={
            <>
              {!showCc && (
                <button onClick={() => setShowCc(true)} className="rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-muted hover:text-fg">
                  Cc
                </button>
              )}
              {!showBcc && (
                <button onClick={() => setShowBcc(true)} className="rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-muted hover:text-fg">
                  Bcc
                </button>
              )}
            </>
          }
        />
        {showCc && <RecipientInput label="Cc" value={state.cc} onChange={(cc) => draft.update({ cc })} autoFocus={!state.cc.length} />}
        {showBcc && <RecipientInput label="Bcc" value={state.bcc} onChange={(bcc) => draft.update({ bcc })} autoFocus={!state.bcc.length} />}
        <div className="flex h-10 items-center border-b border-line px-3">
          <input
            value={state.subject}
            onChange={(e) => draft.update({ subject: e.target.value })}
            placeholder="Subject"
            aria-label="Subject"
            className="h-full w-full bg-transparent text-[14px] font-medium outline-none placeholder:font-normal placeholder:text-fg-faint"
          />
          {state.priority !== "normal" && (
            <span className={cx("ml-2 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium", state.priority === "high" ? "bg-danger-soft text-danger" : "bg-muted text-fg-muted")}>
              {state.priority === "high" ? "High priority" : "Low priority"}
            </span>
          )}
        </div>

        {showToolbar && <EditorToolbar editor={editor} onInsertImage={() => imageInput.current?.click()} className="border-b border-line px-2 py-1" />}

        <div className="min-h-0 flex-1 cursor-text overflow-y-auto px-4 py-3" onClick={(e) => e.target === e.currentTarget && editor?.commands.focus("end")}>
          <EditorContent editor={editor} />
          {state.quoteHtml && state.keepQuote && (
            <div className="mt-2">
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setShowQuote((s) => !s)}
                  title={showQuote ? "Hide quoted text" : "Show quoted text"}
                  className="rounded bg-muted px-2 text-fg-muted hover:bg-line hover:text-fg"
                >
                  <MoreHorizontal className="size-4" />
                </button>
                {showQuote && (
                  <button onClick={() => draft.update({ keepQuote: false })} className="rounded px-1.5 text-xs text-fg-muted hover:text-danger">
                    Remove quoted text
                  </button>
                )}
              </div>
              {showQuote && (
                <div className="mt-2 rounded-ui border border-line">
                  <EmailFrame html={state.quoteHtml} attachments={state.attachments} allowRemote maxHeight={400} />
                </div>
              )}
            </div>
          )}
        </div>

        {state.attachments.some((a) => !a.inline) && (
          <div className="flex max-h-28 flex-wrap gap-2 overflow-y-auto border-t border-line px-3 py-2">
            {state.attachments
              .filter((a) => !a.inline)
              .map((a) => (
                <AttachmentChip key={a.id} attachment={a} progress={a.tempId && !a.error ? a.progress : undefined} error={a.error} onRemove={() => draft.removeAttachment(a.id)} />
              ))}
          </div>
        )}

        <div className="flex items-center gap-1 border-t border-line px-3 py-2">
          <div className="flex">
            <Button variant="primary" className="rounded-r-none" loading={busy} icon={<Send className="size-4" />} onClick={() => send()}>
              Send
            </Button>
            <Menu
              align="start"
              items={[{ label: "Schedule send", icon: <Clock />, onSelect: () => setScheduleOpen(true) }]}
              trigger={(p) => (
                <Button {...p} variant="primary" className="rounded-l-none border-l border-black/10 px-2" aria-label="More send options">
                  <ChevronDown className="size-4" />
                </Button>
              )}
            />
          </div>
          <IconButton label="Formatting" active={showToolbar} onClick={() => setShowToolbar((s) => !s)}>
            <Type className="size-4" />
          </IconButton>
          <IconButton label="Attach files" onClick={() => fileInput.current?.click()}>
            <Paperclip className="size-4" />
          </IconButton>
          <Menu
            width={260}
            items={
              templates.length
                ? templates.map((t) => ({
                    label: t.name,
                    hint: t.scope === "org" ? "Shared" : "Personal",
                    icon: <FileText />,
                    onSelect: () => {
                      editor?.chain().focus().insertContent(t.html).run();
                      if (!state.subject && t.subject) draft.update({ subject: t.subject });
                    },
                  }))
                : [{ label: "No templates yet", disabled: true }]
            }
            trigger={(p) => (
              <IconButton label="Insert template" {...p}>
                <FileText className="size-4" />
              </IconButton>
            )}
          />
          <Menu
            items={[
              { label: "High priority", icon: <Flag />, checked: state.priority === "high", onSelect: () => draft.update({ priority: state.priority === "high" ? "normal" : "high" }) },
              { label: "Low priority", icon: <Flag />, checked: state.priority === "low", onSelect: () => draft.update({ priority: state.priority === "low" ? "normal" : "low" }) },
              { label: "Request read receipt", icon: <Receipt />, checked: state.readReceipt, onSelect: () => draft.update({ readReceipt: !state.readReceipt }) },
              { separator: true, label: "" },
              { label: "Save as template", icon: <Save />, onSelect: saveAsTemplate },
            ]}
            trigger={(p) => (
              <IconButton label="More options" {...p}>
                <MoreHorizontal className="size-4" />
              </IconButton>
            )}
          />
          <span className={cx("ml-auto truncate pr-1 text-xs", draft.status === "error" ? "text-danger" : "text-fg-faint")}>{statusText}</span>
          <IconButton label="Discard draft" onClick={discard}>
            <Trash2 className="size-4" />
          </IconButton>
        </div>

        {dragging && (
          <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-ui border-2 border-dashed border-accent bg-accent-softer text-sm font-medium text-accent backdrop-blur-[1px]">
            Drop files to attach
          </div>
        )}
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => (e.target.files && addFiles(e.target.files), (e.target.value = ""))} />
        <input ref={imageInput} type="file" accept="image/*" hidden onChange={(e) => (e.target.files?.[0] && insertInlineImage(e.target.files[0]), (e.target.value = ""))} />
      </div>
      <ScheduleDialog
        open={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
        onSchedule={(iso) => {
          setScheduleOpen(false);
          send(iso);
        }}
      />
    </Shell>
  );
}

function Shell({
  minimized,
  fullscreen,
  title,
  onClose,
  onToggleMinimize,
  onToggleFullscreen,
  children,
  rootRef,
}: {
  minimized: boolean;
  fullscreen: boolean;
  title: string;
  onClose: () => void;
  onToggleMinimize: () => void;
  onToggleFullscreen?: () => void;
  children: React.ReactNode;
  rootRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const header = (
    <div className="flex h-10 shrink-0 cursor-pointer items-center gap-1 border-b border-line bg-subtle pr-1.5 pl-3.5 select-none" onClick={onToggleMinimize}>
      <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{title}</span>
      <span className="flex max-sm:hidden" onClick={(e) => e.stopPropagation()}>
        <IconButton size="sm" label={minimized ? "Expand" : "Minimize"} onClick={onToggleMinimize}>
          <Minus className="size-4" />
        </IconButton>
        {onToggleFullscreen && !minimized && (
          <IconButton size="sm" label={fullscreen ? "Exit full screen" : "Full screen"} onClick={onToggleFullscreen}>
            {fullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </IconButton>
        )}
      </span>
      <span onClick={(e) => e.stopPropagation()}>
        <IconButton size="sm" label="Save & close" onClick={onClose}>
          <X className="size-4" />
        </IconButton>
      </span>
    </div>
  );

  if (fullscreen && !minimized) {
    return (
      <div className="pointer-events-auto fixed inset-0 z-[70] flex items-center justify-center bg-black/30 p-4 max-sm:p-0">
        <div ref={rootRef} className="animate-in flex h-full max-h-[900px] w-full max-w-5xl flex-col overflow-hidden rounded-ui-lg border border-line bg-raised shadow-ui-lg max-sm:rounded-none">
          {header}
          {children}
        </div>
      </div>
    );
  }
  return (
    <div
      ref={rootRef}
      className={cx(
        "animate-in pointer-events-auto flex flex-col overflow-hidden rounded-t-ui-lg border border-b-0 border-line bg-raised shadow-ui-lg",
        minimized ? "w-72" : "h-[min(620px,calc(100vh-5rem))] w-[560px] max-sm:fixed max-sm:inset-0 max-sm:h-full max-sm:w-full max-sm:rounded-none max-sm:pt-[env(safe-area-inset-top)] max-sm:pb-[env(safe-area-inset-bottom)]",
      )}
    >
      {header}
      {!minimized && children}
    </div>
  );
}

const splitAddress = (addr: string): [string, string] => {
  const at = addr.lastIndexOf("@");
  return [addr.slice(0, at), addr.slice(at + 1).toLowerCase()];
};

/** Order addresses by mail domain (primary first); non-domain addresses go last. */
const domainRank = (domains: string[], addr: string) => {
  const i = domains.indexOf(splitAddress(addr)[1]);
  return i === -1 ? domains.length : i;
};

const SEND_DOMAIN_KEY = "inboxos.sendDomain";
function lastSendDomain(): string | null {
  try {
    return localStorage.getItem(SEND_DOMAIN_KEY);
  } catch {
    return null;
  }
}
function rememberSendDomain(domain: string) {
  try {
    localStorage.setItem(SEND_DOMAIN_KEY, domain);
  } catch {
    /* storage unavailable; the choice just isn't remembered */
  }
}

/** Segmented control for picking which mail domain to send from. */
function DomainSwitch({ options, value, onChange, className }: { options: string[]; value: string; onChange: (address: string) => void; className?: string }) {
  return (
    <div role="radiogroup" aria-label="Send from domain" className={cx("flex shrink overflow-x-auto rounded-full bg-muted p-0.5", className)}>
      {options.map((addr) => {
        const selected = addr === value;
        return (
          <button
            key={addr}
            type="button"
            role="radio"
            aria-checked={selected}
            title={`Send as ${addr}`}
            onClick={() => onChange(addr)}
            className={cx(
              "shrink-0 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors",
              selected ? "bg-accent text-accent-fg shadow-ui-sm" : "text-fg-muted hover:text-fg",
            )}
          >
            {splitAddress(addr)[1]}
          </button>
        );
      })}
    </div>
  );
}
