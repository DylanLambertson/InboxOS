import { useState } from "react";
import { AlertTriangle, Ban, ChevronDown, Code2, Download, Forward, ImageOff, MoreHorizontal, Printer, Reply, ReplyAll, Star, Eye, MousePointerClick } from "lucide-react";
import type { MessageDetail } from "@shared/types";
import { displayName, fullAddress, longDate, relativeTime } from "@/lib/format";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { useMe } from "@/lib/queries";
import { Avatar, Button, cx, IconButton } from "../ui/primitives";
import { Menu, Modal, useConfirm } from "../ui/overlay";
import { AttachmentChip } from "./AttachmentChip";
import { EmailFrame } from "./EmailFrame";
import { EVENT_LABELS, StatusBadge } from "./StatusBadge";

export function printMessage(m: MessageDetail) {
  const w = window.open("", "_blank", "noopener=no");
  if (!w) return;
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  const iframe = document.querySelector<HTMLIFrameElement>(`[data-message="${m.id}"] iframe`);
  const body = iframe?.contentDocument?.body?.innerHTML ?? esc(m.text);
  w.document.write(`<!doctype html><title>${esc(m.subject)}</title><style>body{font-family:system-ui,sans-serif;font-size:13px;margin:32px}h1{font-size:18px}dl{display:grid;grid-template-columns:70px 1fr;gap:2px 8px;color:#444;border-bottom:1px solid #ddd;padding-bottom:12px;margin-bottom:16px}dt{font-weight:600}</style>
<h1>${esc(m.subject || "(no subject)")}</h1><dl><dt>From</dt><dd>${esc(fullAddress(m.from))}</dd><dt>To</dt><dd>${esc(m.to.map(fullAddress).join(", "))}</dd>${m.cc.length ? `<dt>Cc</dt><dd>${esc(m.cc.map(fullAddress).join(", "))}</dd>` : ""}<dt>Date</dt><dd>${esc(longDate(m.date))}</dd></dl>${body}`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
}

export function MessageCard({
  m,
  expanded,
  onToggle,
  onReply,
  onStar,
  readOnly,
}: {
  m: MessageDetail;
  expanded: boolean;
  onToggle: () => void;
  onReply: (mode: "reply" | "replyAll" | "forward") => void;
  onStar: () => void;
  readOnly: boolean;
}) {
  const { data: me } = useMe();
  const [allowRemote, setAllowRemote] = useState(me?.preferences.loadRemoteImages ?? false);
  const [blocked, setBlocked] = useState(0);
  const [showDetails, setShowDetails] = useState(false);
  const [showHeaders, setShowHeaders] = useState(false);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const blockSender = async () => {
    const ok = await confirm({
      title: `Block ${m.from.email}?`,
      body: "Their messages here move to Spam, and future mail goes straight to Spam. You can unblock them in Settings → Mailboxes.",
      confirmLabel: "Block",
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await api.post<{ moved: number }>(`mailboxes/${m.mailboxId}/blocked`, { pattern: m.from.email, moveExisting: true });
      qc.invalidateQueries({ queryKey: ["messages"] });
      qc.invalidateQueries({ queryKey: ["mailboxes"] });
      qc.invalidateQueries({ queryKey: ["blocked", m.mailboxId] });
      toast.success(r.moved ? `Blocked. ${r.moved} message${r.moved === 1 ? "" : "s"} moved to Spam.` : "Blocked. Future mail goes to Spam.");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const visibleAttachments = m.attachments.filter((a) => !a.inline || !(m.html ?? "").includes(`cid:${a.contentId}`));
  const isOut = m.direction === "outbound";

  if (!expanded) {
    return (
      <button onClick={onToggle} className="flex w-full items-center gap-3 border-b border-line px-5 py-3 text-left hover:bg-subtle">
        <Avatar email={m.from.email} name={m.from.name} size={28} />
        <span className={cx("w-40 shrink-0 truncate text-[13px]", !m.isRead && "font-semibold")}>{displayName(m.from)}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-fg-muted">{m.snippet}</span>
        <span className="shrink-0 text-xs text-fg-muted">{relativeTime(m.date)}</span>
      </button>
    );
  }

  return (
    <article data-message={m.id} className="border-b border-line px-5 py-4">
      <header className="flex items-start gap-3">
        <Avatar email={m.from.email} name={m.from.name} size={38} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[14px] font-semibold">{m.from.name || m.from.email}</span>
            {m.from.name && <span className="truncate text-xs text-fg-muted">&lt;{m.from.email}&gt;</span>}
          </div>
          <button onClick={() => setShowDetails((s) => !s)} className="mt-0.5 flex max-w-full items-center gap-1 text-left text-xs text-fg-muted hover:text-fg">
            <span className="truncate">
              to {[...m.to, ...m.cc].map((a) => (a.email === me?.email ? "me" : displayName(a))).join(", ") || "undisclosed recipients"}
            </span>
            <ChevronDown className={cx("size-3 shrink-0 transition", showDetails && "rotate-180")} />
          </button>
          {showDetails && (
            <dl className="animate-in mt-2 grid grid-cols-[64px_1fr] gap-x-3 gap-y-1 rounded-ui border border-line bg-subtle p-3 text-xs">
              <dt className="text-fg-muted">From</dt>
              <dd className="break-all">{fullAddress(m.from)}</dd>
              {m.replyTo.length > 0 && (
                <>
                  <dt className="text-fg-muted">Reply-to</dt>
                  <dd className="break-all">{m.replyTo.map(fullAddress).join(", ")}</dd>
                </>
              )}
              <dt className="text-fg-muted">To</dt>
              <dd className="break-all">{m.to.map(fullAddress).join(", ") || "—"}</dd>
              {m.cc.length > 0 && (
                <>
                  <dt className="text-fg-muted">Cc</dt>
                  <dd className="break-all">{m.cc.map(fullAddress).join(", ")}</dd>
                </>
              )}
              {m.bcc.length > 0 && (
                <>
                  <dt className="text-fg-muted">Bcc</dt>
                  <dd className="break-all">{m.bcc.map(fullAddress).join(", ")}</dd>
                </>
              )}
              <dt className="text-fg-muted">Date</dt>
              <dd>{longDate(m.date)}</dd>
              <dt className="text-fg-muted">Subject</dt>
              <dd className="break-words">{m.subject}</dd>
              {m.sentBy && (
                <>
                  <dt className="text-fg-muted">Sent by</dt>
                  <dd>{m.sentBy.name}</dd>
                </>
              )}
            </dl>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <span className="mr-1 hidden text-xs text-fg-muted sm:inline" title={longDate(m.date)}>
            {relativeTime(m.date)}
          </span>
          <IconButton size="sm" label={m.isStarred ? "Unstar" : "Star"} onClick={onStar}>
            <Star className={cx("size-4", m.isStarred && "fill-amber-400 text-amber-400")} />
          </IconButton>
          {!readOnly && (
            <IconButton size="sm" label="Reply" shortcut="R" onClick={() => onReply("reply")}>
              <Reply className="size-4" />
            </IconButton>
          )}
          <Menu
            align="end"
            items={[
              ...(!readOnly
                ? [
                    { label: "Reply", icon: <Reply />, onSelect: () => onReply("reply") },
                    { label: "Reply all", icon: <ReplyAll />, onSelect: () => onReply("replyAll") },
                    { label: "Forward", icon: <Forward />, onSelect: () => onReply("forward") },
                    { separator: true, label: "" },
                  ]
                : []),
              { label: "Print", icon: <Printer />, onSelect: () => printMessage(m) },
              { label: "Show headers", icon: <Code2 />, onSelect: () => setShowHeaders(true) },
              ...(m.direction === "inbound"
                ? [{ label: "Download original (.eml)", icon: <Download />, onSelect: () => window.open(`/api/messages/${m.id}/original`, "_blank") }]
                : []),
              ...(m.direction === "inbound" && !readOnly
                ? [
                    { separator: true, label: "" },
                    { label: `Block ${m.from.email}`, icon: <Ban />, danger: true, onSelect: () => blockSender() },
                  ]
                : []),
            ]}
            trigger={(p) => (
              <IconButton size="sm" label="More" {...p}>
                <MoreHorizontal className="size-4" />
              </IconButton>
            )}
          />
        </div>
      </header>

      {isOut && m.folder !== "drafts" && (
        <DeliveryPanel m={m} />
      )}
      {m.error && (
        <div className="mt-3 flex items-start gap-2 rounded-ui bg-danger-soft px-3 py-2 text-[13px] text-danger">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          {m.error}
        </div>
      )}

      {blocked > 0 && !allowRemote && (
        <div className="mt-3 flex items-center gap-2 rounded-ui border border-line bg-subtle px-3 py-2 text-[13px] text-fg-muted">
          <ImageOff className="size-4 shrink-0" />
          <span className="flex-1">Remote images are hidden to protect your privacy.</span>
          <Button size="xs" variant="secondary" onClick={() => setAllowRemote(true)}>
            Show images
          </Button>
        </div>
      )}

      <div className="mt-4 pl-0 sm:pl-[50px]">
        <EmailFrame html={m.html} text={m.text} attachments={m.attachments} allowRemote={allowRemote} onBlocked={setBlocked} />
        {visibleAttachments.length > 0 && (
          <div className="mt-4">
            <p className="mb-2 text-xs font-medium text-fg-muted">
              {visibleAttachments.length} attachment{visibleAttachments.length > 1 ? "s" : ""}
            </p>
            <div className="flex flex-wrap gap-2">
              {visibleAttachments.map((a) => (
                <AttachmentChip key={a.id} attachment={a} onPreview={() => window.open(`/api/attachments/${a.id}`, "_blank", "noopener")} />
              ))}
            </div>
          </div>
        )}
      </div>

      <Modal open={showHeaders} onClose={() => setShowHeaders(false)} title="Message headers" width={720}>
        <div className="space-y-1 font-mono text-xs">
          {m.messageIdHeader && <HeaderRow k="Message-ID" v={m.messageIdHeader} />}
          {m.resendId && <HeaderRow k="Provider ID" v={m.resendId} />}
          {Object.entries(m.headers).map(([k, v]) => (
            <HeaderRow key={k} k={k} v={v} />
          ))}
          {!Object.keys(m.headers).length && <p className="font-sans text-fg-muted">No stored headers for this message.</p>}
        </div>
      </Modal>
    </article>
  );
}

function HeaderRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="grid grid-cols-[180px_1fr] gap-3 border-b border-line py-1 last:border-0">
      <span className="truncate text-fg-muted">{k}</span>
      <span className="break-all">{v}</span>
    </div>
  );
}

function DeliveryPanel({ m }: { m: MessageDetail }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3 rounded-ui border border-line sm:ml-[50px]">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-3 px-3 py-2 text-left">
        <StatusBadge status={m.status} />
        {m.scheduledAt && m.status === "scheduled" && <span className="text-xs text-fg-muted">Sends {longDate(m.scheduledAt)}</span>}
        <span className="flex items-center gap-3 text-xs text-fg-muted">
          {m.openCount > 0 && (
            <span className="flex items-center gap-1">
              <Eye className="size-3.5" /> {m.openCount}
            </span>
          )}
          {m.clickCount > 0 && (
            <span className="flex items-center gap-1">
              <MousePointerClick className="size-3.5" /> {m.clickCount}
            </span>
          )}
        </span>
        <span className="ml-auto text-xs text-fg-muted">{open ? "Hide" : "Delivery details"}</span>
        <ChevronDown className={cx("size-3.5 text-fg-faint transition", open && "rotate-180")} />
      </button>
      {open && (
        <ol className="animate-in space-y-2 border-t border-line px-3 py-3">
          {m.events.length === 0 && <li className="text-xs text-fg-muted">No delivery events yet.</li>}
          {m.events.map((e) => (
            <li key={e.id} className="flex gap-3 text-xs">
              <span className={cx("mt-1 size-2 shrink-0 rounded-full", /bounced|failed|complained|suppressed/.test(e.type) ? "bg-danger" : e.type === "delivered" ? "bg-success" : e.type === "delivery_delayed" ? "bg-warning" : "bg-line-strong")} />
              <span className="flex-1">
                <span className="font-medium">{EVENT_LABELS[e.type] ?? e.type}</span>
                {e.detail && <span className="block text-fg-muted">{e.detail}</span>}
              </span>
              <span className="shrink-0 text-fg-muted">{longDate(e.createdAt)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
