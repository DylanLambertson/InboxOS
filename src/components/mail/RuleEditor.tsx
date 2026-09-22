import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";
import {
  FIELD_LABELS,
  MAX_ACTIONS_PER_RULE,
  MAX_CONDITIONS_PER_RULE,
  OPERATOR_LABELS,
  RULE_FIELDS,
  RULE_OPERATORS,
  TEXT_FIELDS,
  type MailRule,
  type MailRuleInput,
  type RuleAction,
  type RuleCondition,
  type RuleField,
  type RuleTestResult,
} from "@shared/mail-rules";
import { api, errorMessage } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { useLabels } from "@/lib/queries";
import { Button, Checkbox, Field, IconButton, Input, Select, Spinner } from "../ui/primitives";
import { Modal } from "../ui/overlay";

const ACTION_TYPES: { value: RuleAction["type"]; label: string }[] = [
  { value: "label", label: "Add label" },
  { value: "move", label: "Move to" },
  { value: "read", label: "Mark as read" },
  { value: "star", label: "Star it" },
  { value: "important", label: "Mark important" },
];

const FIXED_DEFAULTS: Partial<Record<RuleField, string>> = { has_attachment: "yes", size_gt: "1024", sender_contact: "not_in" };

export const EMPTY_RULE: MailRuleInput = {
  name: "",
  enabled: true,
  match: "all",
  conditions: [{ field: "from", op: "contains", value: "" }],
  actions: [{ type: "move", folder: "archive" }],
  stopProcessing: false,
};

const isText = (f: RuleField) => TEXT_FIELDS.includes(f);

function conditionValid(c: RuleCondition): boolean {
  if (isText(c.field)) return !!c.op && !!c.value.trim() && (c.field !== "header" || !!c.header?.trim());
  if (c.field === "size_gt") return /^\d{1,7}$/.test(c.value) && Number(c.value) > 0;
  return !!c.value;
}

function ConditionRow({ c, onChange, onRemove }: { c: RuleCondition; onChange: (c: RuleCondition) => void; onRemove?: () => void }) {
  const setField = (field: RuleField) =>
    onChange(isText(field) ? { field, op: c.op ?? "contains", value: isText(c.field) ? c.value : "", header: c.header } : { field, value: FIXED_DEFAULTS[field] ?? "" });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={c.field} onChange={(e) => setField(e.target.value as RuleField)} className="w-40" aria-label="Field">
        {RULE_FIELDS.map((f) => (
          <option key={f} value={f}>
            {FIELD_LABELS[f]}
          </option>
        ))}
      </Select>
      {c.field === "header" && <Input value={c.header ?? ""} onChange={(e) => onChange({ ...c, header: e.target.value })} placeholder="List-Id" className="w-32" aria-label="Header name" maxLength={100} />}
      {isText(c.field) && (
        <>
          <Select value={c.op ?? "contains"} onChange={(e) => onChange({ ...c, op: e.target.value as RuleCondition["op"] })} className="w-44" aria-label="Operator">
            {RULE_OPERATORS.map((o) => (
              <option key={o} value={o}>
                {OPERATOR_LABELS[o]}
              </option>
            ))}
          </Select>
          <Input
            value={c.value}
            onChange={(e) => onChange({ ...c, value: e.target.value })}
            placeholder={c.op === "wildcard" ? "*@example.com" : "text"}
            className="min-w-32 flex-1"
            aria-label="Value"
            maxLength={300}
          />
        </>
      )}
      {c.field === "has_attachment" && (
        <Select value={c.value} onChange={(e) => onChange({ ...c, value: e.target.value })} className="w-32" aria-label="Has attachment">
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </Select>
      )}
      {c.field === "size_gt" && <Input type="number" min={1} value={c.value} onChange={(e) => onChange({ ...c, value: e.target.value })} className="w-32" aria-label="Size in KB" />}
      {c.field === "sender_contact" && (
        <Select value={c.value} onChange={(e) => onChange({ ...c, value: e.target.value })} className="w-48" aria-label="Contacts">
          <option value="in">is in my contacts</option>
          <option value="not_in">is not in my contacts</option>
        </Select>
      )}
      {onRemove && (
        <IconButton size="sm" label="Remove condition" onClick={onRemove}>
          <X className="size-3.5" />
        </IconButton>
      )}
    </div>
  );
}

function ActionRow({ a, mailboxId, onChange, onRemove }: { a: RuleAction; mailboxId: string; onChange: (a: RuleAction) => void; onRemove?: () => void }) {
  const { data: labels = [] } = useLabels(mailboxId);
  const setType = (type: RuleAction["type"]) =>
    onChange(type === "label" ? { type, labelId: labels[0]?.id ?? "" } : type === "move" ? { type, folder: "archive" } : { type });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={a.type} onChange={(e) => setType(e.target.value as RuleAction["type"])} className="w-40" aria-label="Action">
        {ACTION_TYPES.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </Select>
      {a.type === "label" &&
        (labels.length ? (
          <Select value={a.labelId} onChange={(e) => onChange({ type: "label", labelId: e.target.value })} className="w-44" aria-label="Label">
            {!a.labelId && <option value="">Choose a label</option>}
            {labels.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        ) : (
          <span className="text-xs text-fg-muted">This mailbox has no labels yet.</span>
        ))}
      {a.type === "move" && (
        <Select value={a.folder} onChange={(e) => onChange({ type: "move", folder: e.target.value as "archive" })} className="w-36" aria-label="Folder">
          <option value="archive">Archive</option>
          <option value="spam">Spam</option>
          <option value="trash">Trash</option>
        </Select>
      )}
      {onRemove && (
        <IconButton size="sm" label="Remove action" onClick={onRemove}>
          <X className="size-3.5" />
        </IconButton>
      )}
    </div>
  );
}

/** Live "would match N of the last 50" preview for a draft rule. */
function useRulePreview(mailboxId: string, draft: MailRuleInput, enabled: boolean) {
  const [state, setState] = useState<{ loading: boolean; result: RuleTestResult | null }>({ loading: false, result: null });
  const key = JSON.stringify({ match: draft.match, conditions: draft.conditions });
  useEffect(() => {
    if (!enabled) return setState({ loading: false, result: null });
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(async () => {
      try {
        const result = await api.post<RuleTestResult>(`mailboxes/${mailboxId}/rules/test`, { match: draft.match, conditions: draft.conditions });
        if (live) setState({ loading: false, result });
      } catch {
        if (live) setState({ loading: false, result: null });
      }
    }, 450);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mailboxId, key, enabled]);
  return state;
}

export function RuleEditor({ open, onClose, mailboxId, rule, initial }: { open: boolean; onClose: () => void; mailboxId: string; rule?: MailRule; initial?: Partial<MailRuleInput> }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<MailRuleInput>(EMPTY_RULE);
  const [applyExisting, setApplyExisting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (!open) return;
    setDraft(rule ? { name: rule.name, enabled: rule.enabled, match: rule.match, conditions: rule.conditions, actions: rule.actions, stopProcessing: rule.stopProcessing } : { ...EMPTY_RULE, ...initial });
    setApplyExisting(false);
  }, [open, rule, initial]);

  const set = <K extends keyof MailRuleInput>(k: K, v: MailRuleInput[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const conditionsOk = draft.conditions.length > 0 && draft.conditions.every(conditionValid);
  const actionsOk = (draft.actions.length > 0 || draft.stopProcessing) && draft.actions.every((a) => a.type !== "label" || !!a.labelId);
  const valid = !!draft.name.trim() && conditionsOk && actionsOk;
  const preview = useRulePreview(mailboxId, draft, open && conditionsOk);

  const runExisting = async (ruleId: string) => {
    const r = await api.post<{ checked: number; matched: number }>(`mailboxes/${mailboxId}/rules/${ruleId}/run`);
    qc.invalidateQueries({ queryKey: ["messages"] });
    qc.invalidateQueries({ queryKey: ["mailboxes"] });
    toast.success(`Applied to ${r.matched} of the latest ${r.checked} inbox message${r.checked === 1 ? "" : "s"}.`);
  };

  const save = async () => {
    setSaving(true);
    try {
      const saved = rule ? await api.put<MailRule>(`mailboxes/${mailboxId}/rules/${rule.id}`, { ...draft }) : await api.post<MailRule>(`mailboxes/${mailboxId}/rules`, { ...draft });
      qc.invalidateQueries({ queryKey: ["rules", mailboxId] });
      toast.success(rule ? "Rule saved" : "Rule created");
      if (applyExisting) await runExisting(saved.id);
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    if (!rule) return;
    setRunning(true);
    try {
      await runExisting(rule.id);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={rule ? "Edit rule" : "New rule"}
      description="Rules run on new mail as it arrives, top to bottom."
      width={680}
      footer={
        <>
          {rule && (
            <Button variant="ghost" className="mr-auto" loading={running} onClick={runNow} title="Apply this saved rule to the latest 500 inbox messages">
              Run on existing mail
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={!valid} onClick={save}>
            {rule ? "Save rule" : "Create rule"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="Name">
          <Input value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Invoices to Finance" maxLength={100} autoFocus />
        </Field>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
            When a message matches
            <Select value={draft.match} onChange={(e) => set("match", e.target.value as "all" | "any")} className="w-28" aria-label="Match">
              <option value="all">all</option>
              <option value="any">any</option>
            </Select>
            of these:
          </div>
          {draft.conditions.map((c, i) => (
            <ConditionRow
              key={i}
              c={c}
              onChange={(n) => set("conditions", draft.conditions.map((x, j) => (j === i ? n : x)))}
              onRemove={draft.conditions.length > 1 ? () => set("conditions", draft.conditions.filter((_, j) => j !== i)) : undefined}
            />
          ))}
          {draft.conditions.length < MAX_CONDITIONS_PER_RULE && (
            <Button size="xs" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => set("conditions", [...draft.conditions, { field: "subject", op: "contains", value: "" }])}>
              Add condition
            </Button>
          )}
          <p className="text-xs text-fg-muted">Matching ignores upper/lower case. In patterns, * matches anything and ? one character.</p>
        </div>

        <div className="rounded-ui border border-line bg-subtle px-3 py-2 text-[13px]">
          {!conditionsOk ? (
            <span className="text-fg-muted">Fill in the conditions to preview matches.</span>
          ) : preview.loading && !preview.result ? (
            <span className="flex items-center gap-2 text-fg-muted">
              <Spinner className="size-3.5" /> Checking recent mail…
            </span>
          ) : preview.result ? (
            <div>
              <p className="flex items-center gap-2 font-medium">
                Would match {preview.result.matches.length} of the last {preview.result.checked} received messages
                {preview.loading && <Spinner className="size-3.5" />}
              </p>
              {preview.result.matches.slice(0, 5).map((m) => (
                <p key={m.id} className="mt-1 truncate text-xs text-fg-muted">
                  <span className="text-fg">{m.subject || "(no subject)"}</span> · {m.from} · {relativeTime(m.date)}
                </p>
              ))}
            </div>
          ) : (
            <span className="text-fg-muted">Couldn't preview this rule.</span>
          )}
        </div>

        <div className="space-y-2">
          <p className="text-[13px] font-medium">Do this:</p>
          {draft.actions.map((a, i) => (
            <ActionRow
              key={i}
              a={a}
              mailboxId={mailboxId}
              onChange={(n) => set("actions", draft.actions.map((x, j) => (j === i ? n : x)))}
              onRemove={() => set("actions", draft.actions.filter((_, j) => j !== i))}
            />
          ))}
          {draft.actions.length < MAX_ACTIONS_PER_RULE && (
            <Button size="xs" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => set("actions", [...draft.actions, { type: "read" }])}>
              Add action
            </Button>
          )}
          <Checkbox checked={draft.stopProcessing} onChange={(v) => set("stopProcessing", v)} label="Stop processing more rules" />
          {!rule && <Checkbox checked={applyExisting} onChange={setApplyExisting} label="Also apply to the latest 500 inbox messages" />}
          <p className="text-xs text-fg-muted">Mail moved to Archive, Spam or Trash, or marked read, doesn't notify anyone. Archive, Spam and Trash also skip the auto-reply.</p>
        </div>
      </div>
    </Modal>
  );
}
