import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { useDomainList, useRefreshSetup } from "@/lib/setup";
import { AutoWebhookButton, ManualWebhookSteps } from "@/components/setup/ProviderForms";
import { CopyField } from "@/components/setup/StatusBadges";
import { Button, Spinner, Switch } from "@/components/ui/primitives";
import { DoneNote, Panel, StepFrame, type StepProps } from "../StepFrame";

function DomainReceiving() {
  const { data, isLoading } = useDomainList();
  const qc = useQueryClient();
  const refresh = useRefreshSetup();
  const [busy, setBusy] = useState<string | null>(null);
  if (isLoading) return <Spinner className="size-4" />;
  const domains = data?.domains ?? [];
  if (!domains.length) return <p className="text-[13px] text-fg-muted">Add a domain first.</p>;
  return (
    <ul className="divide-y divide-line">
      {domains.map((d) => (
        <li key={d.name} className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-fg">{d.name}</div>
            <div className="text-xs text-fg-muted">
              {!d.provider ? "Not in Resend yet" : d.provider.receiving ? "Receiving on: make sure its MX record is in place (see Domains)." : "Sending only"}
            </div>
          </div>
          {d.provider && (
            <Switch
              checked={!!d.provider.receiving}
              disabled={busy === d.name}
              label={`Receive mail at ${d.name}`}
              onChange={async (v) => {
                setBusy(d.name);
                try {
                  await api.put(`admin/domains/${encodeURIComponent(d.name)}/receiving`, { enabled: v });
                  await qc.invalidateQueries({ queryKey: ["admin-domain", d.name] });
                  await refresh();
                  toast.success(v ? `Receiving on for ${d.name}. Add the new MX record shown on the Domains step.` : `Receiving off for ${d.name}`);
                } catch (err) {
                  toast.error(errorMessage(err));
                } finally {
                  setBusy(null);
                }
              }}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

export function ReceivingStep({ setup, next, skip, back }: StepProps) {
  const secret = setup.provider.webhookSecret;
  const hook = setup.webhook;
  const [manual, setManual] = useState(!!hook.problem);
  return (
    <StepFrame
      title="Receive mail"
      description="Resend accepts mail for your domains and hands each message to this app through a webhook. One click sets that up."
      onBack={back}
      onSkip={secret.configured ? undefined : skip}
      onContinue={next}
      continueDisabled={!secret.configured}
    >
      <Panel title="Webhook" description="Delivers incoming mail plus delivery updates (delivered, bounced, opened…).">
        <div className="space-y-4">
          <CopyField value={hook.endpoint} />
          {secret.configured ? (
            <DoneNote>
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
              <div className="flex-1">
                <div className="font-medium">Webhook connected</div>
                <div className="text-xs opacity-80">
                  {secret.source === "env"
                    ? "Signing secret set as the RESEND_WEBHOOK_SECRET Worker secret."
                    : hook.registered?.source === "auto"
                      ? "Registered in Resend for every email event; its signing secret is stored encrypted."
                      : "Using the signing secret you pasted."}
                </div>
              </div>
            </DoneNote>
          ) : (
            <>
              {hook.problem && (
                <div className="flex gap-2.5 rounded-ui border border-warning/30 bg-warning-soft px-3 py-2.5 text-[13px] text-warning">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <span>{hook.problem}</span>
                </div>
              )}
              {!setup.provider.apiKey.configured && <p className="text-[13px] text-fg-muted">Connect the email provider first to set this up automatically.</p>}
              <div className="flex flex-wrap gap-2">
                <AutoWebhookButton disabled={!setup.provider.apiKey.configured || !!hook.problem} />
                <Button variant="ghost" onClick={() => setManual((v) => !v)}>
                  {manual ? "Hide manual steps" : "Set it up by hand instead"}
                </Button>
              </div>
            </>
          )}
          {manual && !secret.configured && <ManualWebhookSteps endpoint={hook.endpoint} />}
        </div>
      </Panel>

      <Panel title="Which domains receive mail" description="Usually all of them. Turn one off if another service (like Google Workspace) should keep its mail.">
        <DomainReceiving />
      </Panel>
    </StepFrame>
  );
}
