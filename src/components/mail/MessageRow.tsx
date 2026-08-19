import { memo } from "react";
import { AlertCircle, Clock, Paperclip, Star } from "lucide-react";
import type { Label, MessageListItem } from "@shared/types";
import { displayName, shortDate } from "@/lib/format";
import { Avatar, Checkbox, cx } from "../ui/primitives";
import { StatusBadge } from "./StatusBadge";

interface Props {
  m: MessageListItem;
  selected: boolean;
  checked: boolean;
  focused: boolean;
  compact: boolean;
  labels: Label[];
  showRecipients: boolean;
  onOpen: (m: MessageListItem) => void;
  onCheck: (m: MessageListItem, v: boolean, shift: boolean) => void;
  onStar: (m: MessageListItem) => void;
}

export const MessageRow = memo(function MessageRow({ m, selected, checked, focused, compact, labels, showRecipients, onOpen, onCheck, onStar }: Props) {
  const who = showRecipients
    ? m.to.length
      ? `To: ${m.to.map((a) => displayName(a)).join(", ")}`
      : "(no recipients)"
    : displayName(m.from) || m.from.email;
  const unread = !m.isRead;
  const rowLabels = labels.filter((l) => m.labels.includes(l.id));
  const date = m.folder === "scheduled" && m.scheduledAt ? m.scheduledAt : m.date;

  return (
    <div
      role="option"
      aria-selected={selected}
      data-id={m.id}
      tabIndex={-1}
      onClick={(e) => (e.metaKey || e.ctrlKey ? onCheck(m, !checked, false) : e.shiftKey ? onCheck(m, true, true) : onOpen(m))}
      className={cx(
        "group relative flex cursor-pointer gap-3 border-b border-line px-3 transition-colors select-none",
        compact ? "py-2" : "py-3",
        selected ? "bg-accent-soft" : checked ? "bg-accent-softer" : "hover:bg-subtle",
        focused && !selected && "ring-1 ring-accent/40 ring-inset",
      )}
    >
      {unread && <span className="absolute top-1/2 left-1 size-1.5 -translate-y-1/2 rounded-full bg-accent" aria-label="Unread" />}
      <div className="relative flex shrink-0 items-start pt-0.5">
        <div className={cx("transition-opacity", checked ? "opacity-0" : "group-hover:opacity-0", compact && "hidden")}>
          <Avatar email={showRecipients ? m.to[0]?.email ?? m.from.email : m.from.email} name={showRecipients ? m.to[0]?.name : m.from.name} size={32} />
        </div>
        <div className={cx("flex items-center justify-center", compact ? "" : "absolute inset-0 transition-opacity", !compact && (checked ? "opacity-100" : "opacity-0 group-hover:opacity-100"))}>
          <Checkbox checked={checked} label="Select message" onChange={(v) => onCheck(m, v, false)} />
        </div>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cx("min-w-0 flex-1 truncate text-[13px]", unread ? "font-semibold text-fg" : "text-fg")}>
            {who}
            {m.threadCount > 1 && <span className="ml-1.5 text-xs font-normal text-fg-faint">{m.threadCount}</span>}
          </span>
          {m.hasAttachments && <Paperclip className="size-3.5 shrink-0 text-fg-faint" />}
          {m.folder === "scheduled" && <Clock className="size-3.5 shrink-0 text-accent" />}
          <span className={cx("shrink-0 text-xs tabular-nums", unread ? "font-semibold text-fg" : "text-fg-muted")}>{shortDate(date)}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <span className={cx("min-w-0 flex-1 truncate text-[13px]", unread ? "font-medium text-fg" : "text-fg-muted")}>
            {m.folder === "drafts" && <span className="mr-1 font-medium text-danger">Draft</span>}
            {m.subject || "(no subject)"}
            {compact && m.snippet && <span className="font-normal text-fg-faint"> — {m.snippet}</span>}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onStar(m);
            }}
            aria-label={m.isStarred ? "Unstar" : "Star"}
            className={cx("shrink-0 rounded p-0.5 transition", m.isStarred ? "text-amber-400" : "text-fg-faint opacity-0 group-hover:opacity-100 hover:text-fg")}
          >
            <Star className={cx("size-3.5", m.isStarred && "fill-current")} />
          </button>
        </div>
        {!compact && (
          <div className="mt-0.5 flex items-center gap-1.5">
            <p className="min-w-0 flex-1 truncate text-[13px] text-fg-faint">{m.snippet || " "}</p>
          </div>
        )}
        {(rowLabels.length > 0 || (m.direction === "outbound" && ["bounced", "failed", "complained", "delivery_delayed", "delivered"].includes(m.status))) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {m.direction === "outbound" && m.folder !== "drafts" && <StatusBadge status={m.status} />}
            {m.folder === "drafts" && m.status === "failed" && (
              <span className="inline-flex items-center gap-1 text-[11px] text-danger">
                <AlertCircle className="size-3" /> Send failed
              </span>
            )}
            {rowLabels.map((l) => (
              <span key={l.id} className="rounded-full px-1.5 py-px text-[11px] font-medium" style={{ background: `${l.color}1f`, color: l.color }}>
                {l.name}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
