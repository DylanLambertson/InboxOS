import { useEffect, useRef, type ReactNode } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import type { SetupStepId } from "@shared/setup";
import type { AdminSetup } from "@/lib/setup";
import { Button } from "@/components/ui/primitives";

/** What every wizard step gets from the shell. */
export interface StepProps {
  setup: AdminSetup;
  /** Go to the following step. */
  next: () => void;
  back: () => void;
  /** Mark this step "do this later" and move on. */
  skip: () => void;
  goto: (step: SetupStepId) => void;
}

/**
 * Layout of one step: heading, body, and the Back / Do this later / Continue row.
 * The heading takes focus when the step opens, so keyboard and screen-reader users
 * start at the top of the new step.
 */
export function StepFrame({
  eyebrow,
  title,
  description,
  children,
  onBack,
  onSkip,
  onContinue,
  continueLabel = "Continue",
  continueDisabled,
  continueLoading,
  skipLabel = "Do this later",
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  onBack?: () => void;
  onSkip?: () => void;
  onContinue?: () => void;
  continueLabel?: string;
  continueDisabled?: boolean;
  continueLoading?: boolean;
  skipLabel?: string;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  return (
    <section aria-labelledby="setup-step-title" className="flex min-h-full flex-col">
      <header className="mb-7">
        {eyebrow && <p className="mb-2 text-xs font-medium tracking-wide text-accent-ink uppercase">{eyebrow}</p>}
        <h1 id="setup-step-title" ref={heading} tabIndex={-1} className="text-2xl font-semibold tracking-tight text-fg outline-none">
          {title}
        </h1>
        {description && <div className="mt-2 max-w-xl text-sm text-fg-muted">{description}</div>}
      </header>
      <div className="flex-1 space-y-6">{children}</div>
      {(onBack || onSkip || onContinue) && (
        <footer className="mt-10 flex flex-wrap items-center gap-2 border-t border-line pt-5">
          {onBack && (
            <Button variant="ghost" icon={<ArrowLeft className="size-4" />} onClick={onBack}>
              Back
            </Button>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {onSkip && (
              <Button variant="ghost" onClick={onSkip}>
                {skipLabel}
              </Button>
            )}
            {onContinue && (
              <Button variant="primary" onClick={onContinue} disabled={continueDisabled} loading={continueLoading}>
                {continueLabel}
                {!continueLoading && <ArrowRight className="size-4" />}
              </Button>
            )}
          </div>
        </footer>
      )}
    </section>
  );
}

/** A soft panel used inside steps. */
export function Panel({ title, description, children, actions }: { title?: string; description?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="rounded-ui-lg border border-line bg-surface p-5 shadow-ui-sm">
      {(title || actions) && (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            {title && <h2 className="text-[15px] font-semibold text-fg">{title}</h2>}
            {description && <p className="mt-0.5 text-[13px] text-fg-muted">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}

/** Green "done" note shown when a step is already complete. */
export function DoneNote({ children }: { children: ReactNode }) {
  return <div className="flex items-start gap-2.5 rounded-ui border border-success/25 bg-success-soft px-3.5 py-3 text-[13px] text-success">{children}</div>;
}
