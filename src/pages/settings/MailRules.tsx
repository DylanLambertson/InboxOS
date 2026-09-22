import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Filter, GripVertical, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { MailboxSummary } from "@shared/types";
import { FIELD_LABELS, MAX_RULES_PER_MAILBOX, OPERATOR_LABELS, type MailRule, type RuleAction, type RuleCondition } from "@shared/mail-rules";
import { api, errorMessage } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { useLabels } from "@/lib/queries";
import { RuleEditor } from "@/components/mail/RuleEditor";
import { Button, cx, IconButton, Switch } from "@/components/ui/primitives";
import { useConfirm } from "@/components/ui/overlay";

export const useRules = (mailboxId: string) => useQuery({ queryKey: ["rules", mailboxId], queryFn: () => api.get<MailRule[]>(`mailboxes/${mailboxId}/rules`) });

function describeCondition(c: RuleCondition): string {
  if (c.field === "has_attachment") return c.value === "no" ? "no attachment" : "has attachment";
  if (c.field === "size_gt") return `larger than ${c.value} KB`;
  if (c.field === "sender_contact") return c.value === "in" ? "sender in contacts" : "sender not in contacts";
  const name = c.field === "header" ? c.header || "header" : FIELD_LABELS[c.field];
  return `${name} ${OPERATOR_LABELS[c.op ?? "contains"].replace(" (* ?)", "")} “${c.value}”`;
}

function describeAction(a: RuleAction, labelName: (id: string) => string): string {
  switch (a.type) {
    case "label":
      return `label “${labelName(a.labelId)}”`;
    case "move":
      return `move to ${a.folder[0].toUpperCase()}${a.folder.slice(1)}`;
    case "read":
      return "mark read";
    case "star":
      return "star";
    case "important":
      return "mark important";
  }
}

/** Mail rules (filters) for one mailbox, shown on its settings card. */
export function MailRulesSection({ box }: { box: MailboxSummary }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const canEdit = box.role !== "viewer";
  const key = ["rules", box.id];
  const { data: rules = [] } = useRules(box.id);
  const { data: labels = [] } = useLabels(box.id);
  const [editing, setEditing] = useState<MailRule | undefined>();
  const [open, setOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const labelName = (id: string) => labels.find((l) => l.id === id)?.name ?? "deleted label";

  const reorder = async (ids: string[]) => {
    const prev = rules;
    qc.setQueryData<MailRule[]>(key, ids.map((id) => rules.find((r) => r.id === id)!));
    try {
      qc.setQueryData(key, await api.post<MailRule[]>(`mailboxes/${box.id}/rules/reorder`, { ids }));
    } catch (e) {
      qc.setQueryData(key, prev);
      toast.error(errorMessage(e));
    }
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= rules.length || from === to) return;
    const ids = rules.map((r) => r.id);
    const [id] = ids.splice(from, 1);
    ids.splice(to, 0, id);
    reorder(ids);
  };
  const toggle = async (r: MailRule, enabled: boolean) => {
    qc.setQueryData<MailRule[]>(key, (list) => list?.map((x) => (x.id === r.id ? { ...x, enabled } : x)));
    try {
      await api.patch(`mailboxes/${box.id}/rules/${r.id}`, { enabled });
    } catch (e) {
      toast.error(errorMessage(e));
      qc.invalidateQueries({ queryKey: key });
    }
  };
  const remove = async (r: MailRule) => {
    if (!(await confirm({ title: `Delete “${r.name}”?`, body: "Mail it already filed stays where it is.", confirmLabel: "Delete", danger: true }))) return;
    try {
      await api.del(`mailboxes/${box.id}/rules/${r.id}`);
      qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className="border-t border-line pt-5">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Filter className="size-4 text-fg-muted" />
          <p className="text-[13px] font-medium">Rules</p>
        </div>
        {canEdit && (
          <Button size="sm" disabled={rules.length >= MAX_RULES_PER_MAILBOX} onClick={() => (setEditing(undefined), setOpen(true))}>
            New rule
          </Button>
        )}
      </div>
      <p className="mb-3 text-xs text-fg-muted">Sort, label and file incoming mail automatically. Rules run top to bottom.</p>
      {rules.length === 0 && <p className="text-xs text-fg-faint">No rules yet.</p>}
      <ol className="divide-y divide-line">
        {rules.map((r, i) => (
          <li
            key={r.id}
            draggable={canEdit}
            onDragStart={() => setDragId(r.id)}
            onDragEnd={() => setDragId(null)}
            onDragOver={(e) => canEdit && dragId && e.preventDefault()}
            onDrop={() => {
              const from = rules.findIndex((x) => x.id === dragId);
              if (from >= 0) move(from, i);
              setDragId(null);
            }}
            className={cx("flex items-start gap-2 py-2", dragId === r.id && "opacity-50", !r.enabled && "text-fg-muted")}
          >
            {canEdit && <GripVertical className="mt-0.5 size-4 shrink-0 cursor-grab text-fg-faint" aria-hidden />}
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium">{r.name}</p>
              <p className="truncate text-xs text-fg-muted">
                If {r.conditions.map(describeCondition).join(r.match === "any" ? " or " : " and ")} → {r.actions.map((a) => describeAction(a, labelName)).join(", ") || "nothing"}
                {r.stopProcessing && ", then stop"}
              </p>
              <p className="text-xs text-fg-faint">
                {r.hits ? `Matched ${r.hits} message${r.hits === 1 ? "" : "s"}${r.lastHitAt ? `, last ${relativeTime(r.lastHitAt)}` : ""}` : "No matches yet"}
              </p>
            </div>
            {canEdit && (
              <div className="flex shrink-0 items-center gap-0.5">
                <IconButton size="sm" label="Move up" disabled={i === 0} onClick={() => move(i, i - 1)}>
                  <ArrowUp className="size-3.5" />
                </IconButton>
                <IconButton size="sm" label="Move down" disabled={i === rules.length - 1} onClick={() => move(i, i + 1)}>
                  <ArrowDown className="size-3.5" />
                </IconButton>
                <IconButton size="sm" label="Edit" onClick={() => (setEditing(r), setOpen(true))}>
                  <Pencil className="size-3.5" />
                </IconButton>
                <IconButton size="sm" label="Delete" onClick={() => remove(r)}>
                  <Trash2 className="size-3.5" />
                </IconButton>
              </div>
            )}
            <span className="mt-0.5">
              <Switch checked={r.enabled} disabled={!canEdit} label={`Rule ${r.name}`} onChange={(v) => toggle(r, v)} />
            </span>
          </li>
        ))}
      </ol>
      {canEdit && <RuleEditor open={open} onClose={() => setOpen(false)} mailboxId={box.id} rule={editing} />}
    </div>
  );
}
