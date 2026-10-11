import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, MoreHorizontal, Pencil, Plus, Send, Trash2, Webhook } from "lucide-react";
import { toast } from "sonner";
import { WEBHOOK_EVENTS, type WebhookEventType } from "@shared/webhooks";
import { api, errorMessage } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { useCanManage } from "@/lib/queries";
import { Badge, Button, Card, cx, EmptyState, IconButton, LoadError, PageHeader, Section, Spinner, Switch } from "@/components/ui/primitives";
import { Menu, useConfirm } from "@/components/ui/overlay";
import { Deliveries, reportAttempt, type AttemptResult } from "./webhooks/Deliveries";
import { EndpointDialog, SecretReveal, type WebhookEndpoint } from "./webhooks/EndpointDialog";
import { VerifySamples } from "./webhooks/VerifySamples";

function Health({ e }: { e: WebhookEndpoint }) {
  if (!e.enabled) return <Badge tone={e.disabledReason ? "danger" : "neutral"}>{e.disabledReason ? "Turned off after failures" : "Off"}</Badge>;
  if (e.failureStreak > 0) return <Badge tone="warning">Failing ({e.failureStreak} in a row)</Badge>;
  if (e.lastSuccessAt) return <Badge tone="success">Healthy</Badge>;
  return <Badge>No deliveries yet</Badge>;
}

const eventLabel = (k: string) => WEBHOOK_EVENTS[k as Exclude<WebhookEventType, "ping">]?.label ?? k;

/**
 * Admin → Webhooks: endpoints that get a signed POST when mail arrives, is sent or
 * bounces, and when people or mailboxes change. Each endpoint shows its health,
 * and its delivery log lets you inspect payloads and redeliver.
 */
export function AdminWebhooks() {
  const editable = useCanManage();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: endpoints = [], isLoading, error, refetch } = useQuery({ queryKey: ["admin-webhooks"], queryFn: () => api.get<WebhookEndpoint[]>("admin/webhooks") });
  const [editing, setEditing] = useState<WebhookEndpoint | "new" | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const current = endpoints.find((e) => e.id === selected) ?? endpoints[0];
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["admin-webhooks"] });
    qc.invalidateQueries({ queryKey: ["admin-webhook-deliveries"] });
  };

  const run = async (fn: () => Promise<unknown>, msg?: string) => {
    try {
      await fn();
      if (msg) toast.success(msg);
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const test = async (e: WebhookEndpoint) => {
    setTesting(e.id);
    setSelected(e.id);
    try {
      const r = await api.post<{ result: AttemptResult | null }>(`admin/webhooks/${e.id}/test`);
      reportAttempt(r.result, "Test event");
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setTesting(null);
    }
  };
  const rotate = async (e: WebhookEndpoint) => {
    if (!(await confirm({ title: "Rotate the signing secret?", body: "The current secret stops working right away. Update your receiver with the new one.", confirmLabel: "Rotate secret", danger: true }))) return;
    run(async () => setSecret((await api.post<{ secret: string }>(`admin/webhooks/${e.id}/rotate-secret`)).secret));
  };
  const remove = async (e: WebhookEndpoint) => {
    if (!(await confirm({ title: "Delete this endpoint?", body: `${e.url} stops receiving events and its delivery log is deleted.`, confirmLabel: "Delete endpoint", danger: true }))) return;
    run(() => api.del(`admin/webhooks/${e.id}`), "Endpoint deleted");
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Webhooks"
        description="Tell your own services, in real time, when mail arrives, is sent or bounces, and when people or mailboxes change."
        actions={editable && endpoints.length > 0 && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>Add endpoint</Button>}
      />

      {isLoading ? (
        <Spinner />
      ) : error ? (
        <Card><LoadError error={error} onRetry={() => refetch()} /></Card>
      ) : !endpoints.length ? (
        <Card>
          <EmptyState
            icon={<Webhook className="size-5" />}
            title="No endpoints yet"
            body="Add the URL of a service that should hear about new mail, deliveries or account changes. Every request is signed so it can't be faked."
            action={editable && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>Add endpoint</Button>}
          />
        </Card>
      ) : (
        <Card className="divide-y divide-line">
          {endpoints.map((e) => (
            <div key={e.id} className={cx("flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5", current?.id === e.id && endpoints.length > 1 && "bg-subtle")}>
              <button className="min-w-0 flex-1 text-left" onClick={() => setSelected(e.id)}>
                <p className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-mono text-[13px] font-medium">{e.url}</span>
                  <Health e={e} />
                </p>
                <p className="mt-0.5 truncate text-xs text-fg-muted">
                  {e.description && `${e.description} · `}
                  {e.events.length === 1 ? eventLabel(e.events[0]) : `${e.events.length} events`}
                  {" · "}last 24h: {e.last24h.succeeded} delivered{e.last24h.failed ? `, ${e.last24h.failed} failed` : ""}{e.last24h.pending ? `, ${e.last24h.pending} retrying` : ""}
                  {e.lastSuccessAt && ` · last success ${relativeTime(e.lastSuccessAt)}`}
                  {e.lastFailureAt && e.failureStreak > 0 && ` · last failure ${relativeTime(e.lastFailureAt)}`}
                </p>
                {e.disabledReason && !e.enabled && <p className="mt-0.5 text-xs text-danger">{e.disabledReason} Fix the receiver, then turn it back on.</p>}
              </button>
              {editable && (
                <div className="flex items-center gap-2">
                  <Switch checked={e.enabled} onChange={(v) => run(() => api.patch(`admin/webhooks/${e.id}`, { enabled: v }), v ? "Endpoint turned on" : "Endpoint turned off")} label={`Enable ${e.url}`} />
                  <Button size="sm" icon={<Send className="size-3.5" />} loading={testing === e.id} disabled={!e.enabled} onClick={() => test(e)}>
                    Send test
                  </Button>
                  <Menu
                    align="end"
                    width={200}
                    items={[
                      { label: "Edit", icon: <Pencil />, onSelect: () => setEditing(e) },
                      { label: "Rotate secret", icon: <KeyRound />, onSelect: () => rotate(e) },
                      { separator: true, label: "" },
                      { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => remove(e) },
                    ]}
                    trigger={(p) => (
                      <IconButton label="More" size="sm" {...p}>
                        <MoreHorizontal className="size-4" />
                      </IconButton>
                    )}
                  />
                </div>
              )}
            </div>
          ))}
        </Card>
      )}

      {current && (
        <Section title="Delivery log" description={<>Every request to <span className="font-mono">{current.url}</span>. Click one to see the payload and response, or redeliver it.</>}>
          <Deliveries key={current.id} endpointId={current.id} />
        </Section>
      )}

      <Section title="Verifying requests" description="Check the signature before trusting a request.">
        <VerifySamples />
      </Section>

      {editing && (
        <EndpointDialog
          endpoint={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={(created) => {
            refresh();
            if (created) (setSecret(created.secret), setSelected(created.id));
          }}
        />
      )}
      {secret && <SecretReveal secret={secret} onClose={() => setSecret(null)} />}
    </div>
  );
}
