import { useState } from "react";
import { Copy, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { SUBSCRIBABLE_EVENTS, WEBHOOK_EVENTS, webhookUrlProblem, type WebhookEventInfo } from "@shared/webhooks";
import { api, errorMessage } from "@/lib/api";
import { Button, Field, Input, Switch } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlay";

export interface WebhookEndpoint {
  id: string;
  url: string;
  description: string;
  events: string[];
  enabled: boolean;
  disabledReason: string | null;
  createdAt: string;
  updatedAt: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  failureStreak: number;
  last24h: { succeeded: number; failed: number; pending: number };
}

const GROUPS: WebhookEventInfo["group"][] = ["Mail", "Delivery", "People", "Mailboxes"];

/** Create or edit an endpoint: URL, note, events (grouped) and on/off. */
export function EndpointDialog({ endpoint, onClose, onSaved }: { endpoint?: WebhookEndpoint; onClose: () => void; onSaved: (created?: { id: string; secret: string }) => void }) {
  const [url, setUrl] = useState(endpoint?.url ?? "https://");
  const [description, setDescription] = useState(endpoint?.description ?? "");
  const [events, setEvents] = useState<Set<string>>(new Set(endpoint?.events ?? ["message.received"]));
  const [enabled, setEnabled] = useState(endpoint?.enabled ?? true);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const urlProblem = webhookUrlProblem(url);

  const toggle = (keys: string[], on: boolean) => {
    const next = new Set(events);
    for (const k of keys) (on ? next.add(k) : next.delete(k));
    setEvents(next);
  };

  const save = async () => {
    setBusy(true);
    try {
      const body = { url: url.trim(), description, events: [...events], enabled };
      if (endpoint) {
        await api.patch(`admin/webhooks/${endpoint.id}`, body);
        toast.success("Endpoint saved");
        onSaved();
      } else {
        onSaved(await api.post<{ id: string; secret: string }>("admin/webhooks", body));
      }
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={endpoint ? "Edit endpoint" : "Add a webhook endpoint"}
      description="We'll POST a signed JSON request to this URL whenever one of the chosen events happens."
      width={600}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!!urlProblem || !events.size} onClick={save}>
            {endpoint ? "Save" : "Add endpoint"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Endpoint URL" error={touched ? urlProblem : null} hint="Must be public and use https://.">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => setTouched(true)} placeholder="https://example.com/webhooks/inboxos" className="font-mono text-[13px]" autoFocus />
        </Field>
        <Field label="Description" hint="Optional: what it's for, so teammates know.">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="CRM sync" maxLength={200} />
        </Field>
        <div className="space-y-3">
          <p className="text-[13px] font-medium">Events</p>
          {GROUPS.map((group) => {
            const keys = SUBSCRIBABLE_EVENTS.filter((k) => WEBHOOK_EVENTS[k].group === group);
            const all = keys.every((k) => events.has(k));
            return (
              <fieldset key={group} className="rounded-ui border border-line">
                <legend className="sr-only">{group}</legend>
                <div className="flex items-center justify-between border-b border-line bg-subtle px-3 py-1.5">
                  <span className="text-xs font-semibold text-fg-muted">{group}</span>
                  <button type="button" className="text-xs font-medium text-accent-ink hover:underline" onClick={() => toggle(keys, !all)}>
                    {all ? "Clear" : "Select all"}
                  </button>
                </div>
                <div className="grid gap-x-4 sm:grid-cols-2">
                  {keys.map((k) => (
                    <label key={k} className="flex cursor-pointer items-start gap-2.5 px-3 py-2">
                      <input
                        type="checkbox"
                        checked={events.has(k)}
                        onChange={(e) => toggle([k], e.target.checked)}
                        className="mt-0.5 size-4 shrink-0 cursor-pointer rounded border-line-strong accent-[var(--accent)]"
                      />
                      <span className="min-w-0">
                        <span className="block text-[13px] font-medium">{WEBHOOK_EVENTS[k].label}</span>
                        <span className="block text-xs text-fg-muted">
                          <code className="font-mono">{k}</code> · {WEBHOOK_EVENTS[k].description}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            );
          })}
          {!events.size && <p className="text-xs text-danger">Pick at least one event.</p>}
        </div>
        <label className="flex items-center justify-between gap-3 rounded-ui border border-line px-3 py-2.5">
          <span>
            <span className="block text-[13px] font-medium">Enabled</span>
            <span className="text-xs text-fg-muted">Turned-off endpoints receive nothing until you turn them back on.</span>
          </span>
          <Switch checked={enabled} onChange={setEnabled} label="Enabled" />
        </label>
      </div>
    </Modal>
  );
}

/** The signing secret, shown once after creating or rotating. */
export function SecretReveal({ secret, onClose }: { secret: string; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title="Your signing secret" width={540} footer={<Button variant="primary" onClick={onClose}>I've saved it</Button>}>
      <div className="space-y-3">
        <p className="flex items-start gap-2 rounded-ui bg-warning-soft p-3 text-[13px] text-warning">
          <KeyRound className="mt-0.5 size-4 shrink-0" />
          Copy it now and store it with your receiver. For your security it won't be shown again; if you lose it, rotate it.
        </p>
        <div className="flex gap-2">
          <Input readOnly value={secret} className="font-mono text-xs" onFocus={(e) => e.target.select()} aria-label="Signing secret" />
          <Button icon={<Copy className="size-4" />} onClick={() => (navigator.clipboard.writeText(secret), toast.success("Secret copied"))}>
            Copy
          </Button>
        </div>
        <p className="text-xs text-fg-muted">Use it to check the <code className="font-mono">webhook-signature</code> header on every request (see "Verifying requests" below).</p>
      </div>
    </Modal>
  );
}
