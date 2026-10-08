import { useState } from "react";
import { ChevronDown, Info } from "lucide-react";
import { useDomainList } from "@/lib/setup";
import { AddDomainForm } from "@/components/setup/AddDomainForm";
import { DomainSetupPanel } from "@/components/setup/DomainSetupPanel";
import { DomainStatusBadge } from "@/components/setup/StatusBadges";
import { Badge, Button, cx, LoadError, Spinner } from "@/components/ui/primitives";
import { Panel, StepFrame, type StepProps } from "../StepFrame";

export function DomainsStep({ setup, next, skip, back, goto }: StepProps) {
  const { data, error, isLoading, refetch } = useDomainList();
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const keyConfigured = setup.provider.apiKey.configured;
  const domains = data?.domains ?? [];
  const allVerified = domains.length > 0 && domains.every((d) => d.provider?.status === "verified");
  const expanded = open ?? domains.find((d) => d.provider?.status !== "verified")?.name ?? null;

  return (
    <StepFrame
      title="Add your domain"
      description="The domain your addresses end in. You'll add a few DNS records where the domain is managed; we check them live and tell you when each one is right."
      onBack={back}
      onSkip={allVerified ? undefined : skip}
      onContinue={next}
      continueDisabled={!domains.length}
      continueLabel={allVerified || !domains.length ? "Continue" : "Continue while DNS updates"}
    >
      {!keyConfigured && (
        <div className="flex items-start gap-2.5 rounded-ui bg-subtle px-3.5 py-3 text-[13px] text-fg-muted">
          <Info className="mt-0.5 size-4 shrink-0" />
          <span>
            Connect the email provider first to get the DNS records for your domain.{" "}
            <button type="button" className="font-medium text-accent hover:underline" onClick={() => goto("provider")}>
              Connect Resend
            </button>
          </span>
        </div>
      )}

      {isLoading ? (
        <Spinner className="mx-auto size-5" />
      ) : error || !data ? (
        <LoadError error={error} onRetry={() => refetch()} />
      ) : (
        <>
          {data.error && <p className="rounded-ui bg-warning-soft px-3 py-2 text-[13px] text-warning">{data.error}</p>}
          {domains.length === 0 || adding ? (
            <Panel title={domains.length ? "Add another domain" : "Your domain"} description="Already use it for email elsewhere? You can use a subdomain such as inbox.example.com instead.">
              <AddDomainForm
                hasPrimary={!!data.primaryDomain}
                providerConnected={keyConfigured}
                onAdded={(n) => {
                  setAdding(false);
                  setOpen(n);
                }}
              />
            </Panel>
          ) : null}

          <ul className="space-y-3">
            {domains.map((d) => {
              const isOpen = expanded === d.name;
              return (
                <li key={d.name} className="overflow-hidden rounded-ui-lg border border-line bg-surface shadow-ui-sm">
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => setOpen(isOpen ? "" : d.name)}
                    className="flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-subtle/60"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{d.name}</span>
                    {d.primary && <Badge tone="accent">Primary</Badge>}
                    <DomainStatusBadge status={d.provider?.status} />
                    <ChevronDown className={cx("size-4 text-fg-muted transition-transform", isOpen && "rotate-180")} />
                  </button>
                  {isOpen && (
                    <div className="animate-in border-t border-line px-4 py-4">
                      <DomainSetupPanel name={d.name} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          {domains.length > 0 && !adding && (
            <Button variant="ghost" onClick={() => setAdding(true)}>
              Add another domain
            </Button>
          )}
          {domains.length > 1 && (
            <p className="text-xs text-fg-muted">Every mailbox gets its address on each domain: hello@ on one domain also receives and can send as hello@ on the others.</p>
          )}
        </>
      )}
    </StepFrame>
  );
}
