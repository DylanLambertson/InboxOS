import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Plane, X } from "lucide-react";
import { toast } from "sonner";
import type { MailboxSummary } from "@shared/types";
import { api, errorMessage } from "@/lib/api";
import { Badge, Button, Field, Input, Switch, Textarea } from "@/components/ui/primitives";

interface AutoReply {
  enabled: boolean;
  subject: string;
  message: string;
  startsAt: string | null;
  endsAt: string | null;
  active: boolean;
}

/** ISO → value for <input type="datetime-local"> in the user's time zone. */
const toLocal = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const fromLocal = (v: string) => (v ? new Date(v).toISOString() : null);

/** Vacation responder for one mailbox. */
export function AutoReplySettings({ box }: { box: MailboxSummary }) {
  const qc = useQueryClient();
  const canEdit = box.role !== "viewer";
  const { data } = useQuery({ queryKey: ["autoreply", box.id], queryFn: () => api.get<AutoReply>(`mailboxes/${box.id}/autoreply`) });
  const [form, setForm] = useState<AutoReply | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (data) setForm(data);
  }, [data]);
  if (!form) return null;
  const set = <K extends keyof AutoReply>(k: K, v: AutoReply[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const save = async (next = form) => {
    setSaving(true);
    try {
      const saved = await api.put<AutoReply>(`mailboxes/${box.id}/autoreply`, {
        enabled: next.enabled,
        subject: next.subject,
        message: next.message,
        startsAt: next.startsAt,
        endsAt: next.endsAt,
      });
      qc.setQueryData(["autoreply", box.id], saved);
      toast.success(saved.enabled ? (saved.active ? "Auto-reply is on" : "Auto-reply scheduled") : "Auto-reply is off");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-t border-line pt-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Plane className="size-4 text-fg-muted" />
          <p className="text-[13px] font-medium">Auto-reply</p>
          {data?.active && <Badge tone="accent">On now</Badge>}
          {data?.enabled && !data.active && <Badge>Scheduled</Badge>}
        </div>
        <Switch
          checked={form.enabled}
          disabled={!canEdit || saving}
          label="Auto-reply"
          onChange={(v) => {
            const next = { ...form, enabled: v };
            setForm(next);
            if (!v || next.message.trim()) save(next);
          }}
        />
      </div>
      <p className="mb-3 text-xs text-fg-muted">
        Answers each sender once every few days while you're away. Newsletters, automated mail and your own team never get one.
      </p>
      {(form.enabled || form.message) && (
        <div className="space-y-3">
          <Field label="Subject" hint="Leave empty to reply with “Re: <their subject>”.">
            <Input value={form.subject} onChange={(e) => set("subject", e.target.value)} placeholder="Out of office" disabled={!canEdit} maxLength={200} />
          </Field>
          <Field label="Message">
            <Textarea
              value={form.message}
              onChange={(e) => set("message", e.target.value)}
              rows={5}
              maxLength={5000}
              disabled={!canEdit}
              placeholder={"Thanks for your email! I'm away until Monday with limited access to email.\nFor anything urgent, contact hello@…"}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Starts" hint="Optional. Empty = right away.">
              <Input type="datetime-local" value={toLocal(form.startsAt)} onChange={(e) => set("startsAt", fromLocal(e.target.value))} disabled={!canEdit} />
            </Field>
            <Field label="Ends" hint="Optional. It switches itself off then.">
              <Input type="datetime-local" value={toLocal(form.endsAt)} onChange={(e) => set("endsAt", fromLocal(e.target.value))} disabled={!canEdit} />
            </Field>
          </div>
          {canEdit && (
            <div className="flex justify-end">
              <Button variant="primary" loading={saving} onClick={() => save()} disabled={form.enabled && !form.message.trim()}>
                Save auto-reply
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Senders whose mail goes straight to Spam for one mailbox. */
export function BlockedSenders({ box }: { box: MailboxSummary }) {
  const qc = useQueryClient();
  const canEdit = box.role !== "viewer";
  const key = ["blocked", box.id];
  const { data: blocked = [] } = useQuery({ queryKey: key, queryFn: () => api.get<{ pattern: string; createdAt: string }[]>(`mailboxes/${box.id}/blocked`) });
  const [pattern, setPattern] = useState("");
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setBusy(true);
    try {
      await api.post(`mailboxes/${box.id}/blocked`, { pattern });
      setPattern("");
      qc.invalidateQueries({ queryKey: key });
      toast.success("Blocked. Their future mail goes to Spam.");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (p: string) => {
    try {
      await api.del(`mailboxes/${box.id}/blocked/${encodeURIComponent(p)}`);
      qc.invalidateQueries({ queryKey: key });
      toast.success(`Unblocked ${p}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className="border-t border-line pt-5">
      <div className="mb-2 flex items-center gap-2">
        <Ban className="size-4 text-fg-muted" />
        <p className="text-[13px] font-medium">Blocked senders</p>
      </div>
      <p className="mb-3 text-xs text-fg-muted">Mail from these goes straight to Spam. Block a whole domain with @example.com.</p>
      {blocked.length > 0 ? (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {blocked.map((b) => (
            <span key={b.pattern} className="inline-flex items-center gap-1 rounded-full bg-muted py-0.5 pl-2.5 pr-1 text-xs">
              {b.pattern}
              {canEdit && (
                <button aria-label={`Unblock ${b.pattern}`} onClick={() => remove(b.pattern)} className="rounded-full p-0.5 hover:bg-line">
                  <X className="size-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      ) : (
        <p className="mb-3 text-xs text-fg-faint">Nobody is blocked.</p>
      )}
      {canEdit && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (pattern.trim()) add();
          }}
        >
          <Input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="spammer@example.com or @example.com" />
          <Button type="submit" loading={busy} disabled={!pattern.trim()}>
            Block
          </Button>
        </form>
      )}
    </div>
  );
}
