import { useState } from "react";
import { CheckCircle2, CircleDashed, FlaskConical, Trash2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { useCanManage, useMe } from "@/lib/queries";
import { useAdminSetup, useRefreshSetup, type CredentialStatus } from "@/lib/setup";
import { useConfirm } from "@/components/ui/overlay";
import { Badge, Button, LoadError, Section, Spinner } from "@/components/ui/primitives";
import { ApiKeyForm, AutoWebhookButton, ManualWebhookSteps } from "./ProviderForms";
import { CopyField } from "./StatusBadges";

/** Configured / missing badge for one credential, saying where it comes from. */
export function CredentialBadge({ status }: { status: CredentialStatus }) {
  if (status.unreadable) {
    return (
      <Badge tone="danger">
        <XCircle className="size-3" /> Needs to be entered again
      </Badge>
    );
  }
  if (!status.configured) {
    return (
      <Badge>
        <CircleDashed className="size-3" /> Not set
      </Badge>
    );
  }
  return (
    <Badge tone="success">
      <CheckCircle2 className="size-3" /> {status.source === "env" ? "Worker secret" : "Saved in the app"}
    </Badge>
  );
}

function Row({ title, status, children }: { title: string; status: CredentialStatus; children?: React.ReactNode }) {
  return (
    <div className="space-y-3 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-fg">{title}</div>
          {status.masked && <div className="font-mono text-xs text-fg-muted">{status.masked}</div>}
          {status.unreadable && <div className="text-xs text-danger">It was saved under a different SESSION_SECRET and can't be read. Enter it again.</div>}
        </div>
        <CredentialBadge status={status} />
      </div>
      {children}
    </div>
  );
}

/**
 * The email provider at a glance: the API key (masked), the webhook, and actions to
 * replace, test or remove them. Reused by Admin → Setup and the health page.
 */
export function ProviderStatusCard() {
  const { data, error, isLoading, refetch } = useAdminSetup();
  const { data: me } = useMe();
  const canManage = useCanManage();
  const owner = me?.role === "owner";
  const confirm = useConfirm();
  const refresh = useRefreshSetup();
  const [replacing, setReplacing] = useState(false);
  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  if (isLoading) return <Spinner className="mx-auto my-6 size-5" />;
  if (error || !data) return <LoadError error={error} onRetry={() => refetch()} />;
  const { apiKey, webhookSecret } = data.provider;

  const run = async (kind: string, fn: () => Promise<void>) => {
    setBusy(kind);
    try {
      await fn();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const test = () =>
    run("test", async () => {
      const r = await api.post<{ ok: boolean; message?: string; domainCount?: number }>("admin/setup/provider/test");
      if (r.ok) toast.success(`The key works. ${r.domainCount ?? 0} domain${r.domainCount === 1 ? "" : "s"} in your Resend account.`);
      else toast.error(r.message ?? "The key didn't work.");
    });

  const removeKey = async () => {
    if (!(await confirm({ title: "Remove the API key?", body: "Sending and receiving stop until a new key is added.", confirmLabel: "Remove", danger: true }))) return;
    await run("remove", async () => {
      const r = await api.del<{ stillSetInEnv: boolean }>("admin/setup/provider");
      toast.success(r.stillSetInEnv ? "Removed. The RESEND_API_KEY Worker secret is still in use." : "API key removed");
      await refresh();
    });
  };

  const removeWebhook = async () => {
    if (!(await confirm({ title: "Disconnect the webhook?", body: "Incoming mail and delivery updates stop arriving until it's set up again.", confirmLabel: "Disconnect", danger: true }))) return;
    await run("webhook", async () => {
      await api.del("admin/setup/webhook");
      toast.success("Webhook disconnected");
      await refresh();
    });
  };

  return (
    <Section title="Email provider" description="Resend sends your mail and passes incoming mail to this app.">
      <div className="divide-y divide-line">
        <Row title="API key" status={apiKey}>
          {owner && (replacing || (!apiKey.configured && apiKey.source !== "env")) ? (
            <ApiKeyForm onSaved={() => setReplacing(false)} submitLabel={apiKey.configured ? "Replace" : "Connect"} autoFocus={replacing} />
          ) : null}
          {canManage && (
            <div className="flex flex-wrap gap-2">
              {apiKey.configured && (
                <Button size="sm" icon={<FlaskConical className="size-4" />} loading={busy === "test"} onClick={test}>
                  Test
                </Button>
              )}
              {owner && apiKey.configured && apiKey.source !== "env" && !replacing && (
                <Button size="sm" onClick={() => setReplacing(true)}>
                  Replace
                </Button>
              )}
              {owner && apiKey.source === "app" && (
                <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} loading={busy === "remove"} onClick={removeKey}>
                  Remove
                </Button>
              )}
            </div>
          )}
          {apiKey.source === "env" && <p className="text-xs text-fg-muted">Set as the RESEND_API_KEY Worker secret. Change it with wrangler, or delete that secret to manage the key here.</p>}
        </Row>
        <Row title="Webhook (incoming mail and delivery updates)" status={webhookSecret}>
          <CopyField value={data.webhook.endpoint} />
          {data.webhook.problem && <p className="text-xs text-warning">{data.webhook.problem}</p>}
          {owner && webhookSecret.source !== "env" && (
            <div className="flex flex-wrap gap-2">
              <AutoWebhookButton size="sm" disabled={!apiKey.configured || !!data.webhook.problem} label={webhookSecret.configured ? "Reconnect" : "Set up automatically"} />
              <Button size="sm" variant="ghost" onClick={() => setManual((v) => !v)}>
                {manual ? "Hide manual steps" : "Set up by hand"}
              </Button>
              {webhookSecret.source === "app" && (
                <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} loading={busy === "webhook"} onClick={removeWebhook}>
                  Disconnect
                </Button>
              )}
            </div>
          )}
          {manual && <ManualWebhookSteps endpoint={data.webhook.endpoint} />}
          {webhookSecret.source === "env" && <p className="text-xs text-fg-muted">Set as the RESEND_WEBHOOK_SECRET Worker secret.</p>}
        </Row>
      </div>
    </Section>
  );
}
