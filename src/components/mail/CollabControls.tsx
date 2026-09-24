import { CheckCircle2, CircleDot, Hourglass, UserMinus, UserPlus, UserRound } from "lucide-react";
import { toast } from "sonner";
import type { ConversationInfo, ConversationStatus, MailboxMember, Person } from "@shared/collab";
import { errorMessage } from "@/lib/api";
import { useConversationActions } from "@/lib/collab";
import { Avatar, cx } from "../ui/primitives";
import { Menu, type MenuItem } from "../ui/overlay";

export const STATUS_META: Record<ConversationStatus, { label: string; icon: typeof CircleDot; tone: string }> = {
  open: { label: "Open", icon: CircleDot, tone: "text-accent" },
  pending: { label: "Pending", icon: Hourglass, tone: "text-warning" },
  closed: { label: "Closed", icon: CheckCircle2, tone: "text-success" },
};

export const personName = (p: Pick<Person, "name" | "email">) => p.name || p.email.split("@")[0];

/** Menu entries for picking an assignee: "Assign to me", every member, then "Unassign". */
export function assigneeMenuItems(opts: {
  members: MailboxMember[];
  meId: string | undefined;
  currentId?: string | null;
  onPick: (id: string | null) => void;
}): MenuItem[] {
  const { members, meId, currentId, onPick } = opts;
  const items: MenuItem[] = [];
  if (meId && currentId !== meId) items.push({ label: "Assign to me", icon: <UserRound />, onSelect: () => onPick(meId) });
  if (members.length) {
    if (items.length) items.push({ separator: true, label: "" });
    for (const m of members) {
      items.push({
        label: m.id === meId ? `${personName(m)} (you)` : personName(m),
        hint: m.role === "viewer" ? `${m.email} · read-only` : m.email,
        icon: <Avatar name={m.name} email={m.email} color={m.color} size={16} />,
        checked: m.id === currentId,
        onSelect: () => onPick(m.id),
      });
    }
  }
  // undefined = several conversations with mixed assignees (bulk), so unassigning is always offered.
  if (currentId !== null) items.push({ separator: true, label: "" }, { label: "Unassign", icon: <UserMinus />, onSelect: () => onPick(null) });
  return items;
}

/** Status switch and assignee picker shown under the subject in the reading pane. */
export function ConversationControls({ info, members, meId }: { info: ConversationInfo; members: MailboxMember[]; meId: string | undefined }) {
  const actions = useConversationActions(info.mailboxId, info.threadId);
  const onError = (e: unknown) => toast.error(errorMessage(e));

  const assign = (id: string | null) =>
    actions.assign.mutate(id, {
      onSuccess: () => toast.success(id ? (id === meId ? "Assigned to you" : `Assigned to ${personName(members.find((m) => m.id === id) ?? { name: "", email: "teammate" })}`) : "Unassigned"),
      onError,
    });
  const setStatus = (s: ConversationStatus) => s !== info.status && actions.setStatus.mutate(s, { onError });

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <div role="radiogroup" aria-label="Conversation status" className="inline-flex rounded-ui border border-line bg-surface p-0.5">
        {(Object.keys(STATUS_META) as ConversationStatus[]).map((s) => {
          const meta = STATUS_META[s];
          const active = info.status === s;
          return (
            <button
              key={s}
              role="radio"
              aria-checked={active}
              disabled={!info.canWrite || actions.setStatus.isPending}
              onClick={() => setStatus(s)}
              className={cx(
                "inline-flex h-7 items-center gap-1.5 rounded-ui-sm px-2.5 text-xs font-medium transition-colors disabled:cursor-default",
                active ? "bg-muted text-fg" : "text-fg-muted enabled:hover:text-fg",
                !info.canWrite && !active && "opacity-50",
              )}
            >
              <meta.icon className={cx("size-3.5", active && meta.tone)} />
              {meta.label}
            </button>
          );
        })}
      </div>

      {info.canWrite ? (
        <Menu
          width={260}
          items={assigneeMenuItems({ members, meId, currentId: info.assignee?.id ?? null, onPick: assign })}
          trigger={(p) => (
            <button {...p} className="inline-flex h-8 items-center gap-1.5 rounded-ui border border-line bg-surface px-2.5 text-xs font-medium text-fg hover:bg-subtle">
              <AssigneeLabel assignee={info.assignee} meId={meId} />
            </button>
          )}
        />
      ) : (
        <span className="inline-flex h-8 items-center gap-1.5 px-1 text-xs text-fg-muted">
          <AssigneeLabel assignee={info.assignee} meId={meId} />
        </span>
      )}
    </div>
  );
}

function AssigneeLabel({ assignee, meId }: { assignee: Person | null; meId: string | undefined }) {
  if (!assignee) {
    return (
      <>
        <UserPlus className="size-3.5 text-fg-muted" /> Unassigned
      </>
    );
  }
  return (
    <>
      <Avatar name={assignee.name} email={assignee.email} color={assignee.color} size={18} />
      {assignee.id === meId ? "You" : personName(assignee)}
    </>
  );
}

/** "Priya is replying…" so two people don't answer the same customer. */
export function ReplyingBanner({ people }: { people: Person[] }) {
  if (!people.length) return null;
  const names = people.map(personName);
  const text = names.length === 1 ? `${names[0]} is replying…` : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} are replying…`;
  return (
    <div role="status" className="mx-5 mb-3 flex items-center gap-2 rounded-ui border border-warning/30 bg-warning-soft px-3 py-2 text-[13px] text-fg">
      <span className="flex -space-x-1.5">
        {people.slice(0, 3).map((p) => (
          <Avatar key={p.id} name={p.name} email={p.email} color={p.color} size={20} />
        ))}
      </span>
      <span className="flex-1">{text}</span>
      <span className="flex gap-0.5" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span key={i} className="size-1 animate-pulse rounded-full bg-warning" style={{ animationDelay: `${i * 150}ms` }} />
        ))}
      </span>
    </div>
  );
}
