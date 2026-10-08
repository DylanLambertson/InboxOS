import { useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { ApiKeyForm, ApiKeyHelp } from "@/components/setup/ProviderForms";
import { Button } from "@/components/ui/primitives";
import { DoneNote, Panel, StepFrame, type StepProps } from "../StepFrame";

export function ProviderStep({ setup, next, skip, back }: StepProps) {
  const key = setup.provider.apiKey;
  const [replace, setReplace] = useState(false);
  return (
    <StepFrame
      title="Connect your email provider"
      description={
        <>
          This app sends and receives through <b className="text-fg">Resend</b>. Its free plan covers 3,000 emails a month (100 a day); you can raise the limits later
          without changing anything here.
        </>
      }
      onBack={back}
      onSkip={key.configured ? undefined : skip}
      onContinue={next}
      continueDisabled={!key.configured}
    >
      {key.configured && !replace ? (
        <DoneNote>
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">Connected to Resend</div>
            <div className="mt-0.5 font-mono text-xs opacity-80">{key.masked}</div>
            {key.source === "env" && <div className="mt-1 text-xs opacity-80">Set as the RESEND_API_KEY Worker secret.</div>}
          </div>
          {key.source !== "env" && (
            <Button size="xs" variant="ghost" onClick={() => setReplace(true)}>
              Use another key
            </Button>
          )}
        </DoneNote>
      ) : (
        <>
          {key.unreadable && (
            <p className="rounded-ui bg-warning-soft px-3 py-2 text-[13px] text-warning">
              A key was saved before, but SESSION_SECRET has changed since, so it can't be read. Paste it again.
            </p>
          )}
          <Panel title="Get an API key">
            <ApiKeyHelp />
          </Panel>
          <Panel>
            <ApiKeyForm autoFocus onSaved={() => setReplace(false)} />
          </Panel>
        </>
      )}
    </StepFrame>
  );
}
