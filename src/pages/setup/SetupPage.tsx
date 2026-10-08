import { useEffect, useState, type ComponentType } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Lock, Minus } from "lucide-react";
import { isSetupStep, SETUP_STEPS, STEP_INFO, type SetupStepId, type StepState } from "@shared/setup";
import { api } from "@/lib/api";
import { applyTheme, useBrand } from "@/lib/brand";
import { useMe } from "@/lib/queries";
import { useAdminSetup, useSetupStatus } from "@/lib/setup";
import { Logo } from "@/components/layout/Logo";
import { Button, cx, LoadError, Spinner } from "@/components/ui/primitives";
import type { StepProps } from "./StepFrame";
import { OwnerStep } from "./steps/OwnerStep";
import { UseCaseStep } from "./steps/UseCaseStep";
import { BrandStep } from "./steps/BrandStep";
import { ProviderStep } from "./steps/ProviderStep";
import { DomainsStep } from "./steps/DomainsStep";
import { ReceivingStep } from "./steps/ReceivingStep";
import { MailboxesStep } from "./steps/MailboxesStep";
import { TeamStep } from "./steps/TeamStep";
import { TestStep } from "./steps/TestStep";
import { DoneStep } from "./steps/DoneStep";

const STEPS: Record<Exclude<SetupStepId, "owner">, ComponentType<StepProps>> = {
  useCase: UseCaseStep,
  brand: BrandStep,
  provider: ProviderStep,
  domains: DomainsStep,
  receiving: ReceivingStep,
  mailboxes: MailboxesStep,
  team: TeamStep,
  test: TestStep,
  done: DoneStep,
};

function StepDot({ state, current, index, locked }: { state: StepState; current: boolean; index: number; locked: boolean }) {
  return (
    <span
      aria-hidden
      className={cx(
        "flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold transition-colors",
        state === "done" ? "bg-success text-white" : current ? "bg-accent text-accent-fg ring-4 ring-accent-soft" : state === "skipped" ? "bg-muted text-fg-faint" : "border border-line-strong text-fg-muted",
      )}
    >
      {state === "done" ? <Check className="size-3.5" /> : locked ? <Lock className="size-3" /> : state === "skipped" ? <Minus className="size-3.5" /> : index + 1}
    </span>
  );
}

function StepList({ steps, current, onPick, locked }: { steps: Record<SetupStepId, StepState>; current: SetupStepId; onPick: (s: SetupStepId) => void; locked: boolean }) {
  return (
    <ol className="space-y-0.5">
      {SETUP_STEPS.map((s, i) => {
        const isLocked = locked && s !== "owner";
        const disabled = isLocked || (s === "owner" && steps.owner === "done");
        return (
          <li key={s}>
            <button
              type="button"
              disabled={disabled}
              aria-current={s === current ? "step" : undefined}
              onClick={() => onPick(s)}
              className={cx(
                "flex w-full items-center gap-3 rounded-ui px-2.5 py-2 text-left transition-colors",
                s === current ? "bg-surface shadow-ui-sm" : "hover:bg-muted/70",
                disabled && "cursor-default hover:bg-transparent",
              )}
            >
              <StepDot state={steps[s]} current={s === current} index={i} locked={isLocked} />
              <span className="min-w-0">
                <span className={cx("block text-[13px] font-medium", s === current ? "text-fg" : isLocked ? "text-fg-faint" : "text-fg-muted")}>{STEP_INFO[s].label}</span>
                <span className="block truncate text-xs text-fg-faint">{steps[s] === "skipped" ? "Skipped for now" : STEP_INFO[s].hint}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center px-6 py-12">{children}</div>;
}

/** The first-run setup wizard: full screen, outside the app shell. */
export function SetupPage() {
  const { step: param } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const brand = useBrand();
  const status = useSetupStatus();
  const ownerExists = status.data?.ownerExists;
  const me = useMe();
  const isOwner = me.data?.role === "owner";
  const admin = useAdminSetup(!!ownerExists && isOwner);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (me.data) applyTheme(me.data.preferences.theme, brand.theme.defaultMode);
  }, [me.data, brand.theme.defaultMode]);

  if (status.isLoading || (ownerExists && me.isLoading)) {
    return (
      <Centered>
        <Spinner className="size-5" />
      </Centered>
    );
  }
  if (status.error || !status.data) return <LoadError error={status.error} onRetry={() => status.refetch()} />;

  if (ownerExists && !me.data) {
    return (
      <Centered>
        <div className="io-form-in max-w-sm text-center">
          <Logo size={40} withName={false} />
          <h1 className="mt-6 text-xl font-semibold tracking-tight">Sign in to continue setup</h1>
          <p className="mt-2 text-sm text-fg-muted">This workspace already has an owner. Sign in with that account to pick up where you left off.</p>
          <Button variant="primary" className="mt-6" onClick={() => navigate(`/login?next=${encodeURIComponent("/setup")}`)}>
            Sign in
          </Button>
        </div>
      </Centered>
    );
  }
  if (ownerExists && !isOwner) {
    return (
      <Centered>
        <div className="io-form-in max-w-sm text-center">
          <h1 className="text-xl font-semibold tracking-tight">Only an owner can run setup</h1>
          <p className="mt-2 text-sm text-fg-muted">Ask the owner of this workspace to finish setting it up.</p>
          <Link to="/" className="mt-6 inline-block text-sm font-medium text-accent hover:underline">
            Go to your inbox
          </Link>
        </div>
      </Centered>
    );
  }
  if (ownerExists && (admin.isLoading || !admin.data)) {
    return admin.error ? (
      <LoadError error={admin.error} onRetry={() => admin.refetch()} />
    ) : (
      <Centered>
        <Spinner className="size-5" />
      </Centered>
    );
  }

  const steps = admin.data?.steps ?? status.data.steps;
  const current: SetupStepId = !ownerExists ? "owner" : isSetupStep(param) && param !== "owner" ? param : admin.data!.nextStep;
  const index = SETUP_STEPS.indexOf(current);
  const progress = admin.data?.progress ?? status.data.progress;
  const go = (s: SetupStepId) => {
    setMenuOpen(false);
    navigate(`/setup/${s}`);
  };
  const props: StepProps | null = admin.data
    ? {
        setup: admin.data,
        goto: go,
        next: () => go(SETUP_STEPS[Math.min(index + 1, SETUP_STEPS.length - 1)]),
        back: () => go(SETUP_STEPS[Math.max(index - 1, 1)]),
        skip: () => {
          void api.put("admin/setup/progress", { skip: current }).then(() => qc.invalidateQueries({ queryKey: ["admin-setup"] }));
          go(SETUP_STEPS[Math.min(index + 1, SETUP_STEPS.length - 1)]);
        },
      }
    : null;
  const Step = current === "owner" ? null : STEPS[current];

  return (
    <div className="h-full overflow-y-auto bg-bg">
      <div className="mx-auto flex min-h-full max-w-6xl flex-col lg:flex-row">
        <aside className="shrink-0 border-b border-line bg-subtle/60 px-4 py-4 lg:sticky lg:top-0 lg:h-dvh lg:w-72 lg:overflow-y-auto lg:border-r lg:border-b-0 lg:px-5 lg:py-8">
          <div className="flex items-center justify-between gap-3">
            <Logo size={28} />
            <button type="button" className="flex items-center gap-1 text-xs font-medium text-fg-muted lg:hidden" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
              Step {index + 1} of {SETUP_STEPS.length}
              <ChevronDown className={cx("size-3.5 transition-transform", menuOpen && "rotate-180")} />
            </button>
          </div>
          <div className="mt-4 lg:mt-8">
            <div className="flex items-baseline justify-between text-xs">
              <span className="font-medium text-fg">Setting up {brand.productName}</span>
              <span className="text-fg-muted">{progress}%</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Setup progress">
              <div className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out" style={{ width: `${progress}%` }} />
            </div>
          </div>
          <nav aria-label="Setup steps" className={cx("mt-5 lg:mt-6 lg:block", menuOpen ? "block" : "hidden")}>
            <StepList steps={steps} current={current} onPick={go} locked={!ownerExists} />
          </nav>
          {ownerExists && (
            <Link to="/" className="mt-6 hidden text-xs text-fg-muted hover:text-fg lg:block">
              Leave setup and go to the app
            </Link>
          )}
        </aside>
        <main className="min-w-0 flex-1 px-4 py-8 sm:px-8 lg:px-14 lg:py-14">
          <div key={current} className="io-form-in mx-auto h-full max-w-2xl">
            {current === "owner" ? (
              <OwnerStep
                setupKeySource={status.data.setupKeySource}
                onCreated={async () => {
                  await qc.invalidateQueries();
                  navigate("/setup/useCase", { replace: true });
                }}
              />
            ) : (
              Step && props && <Step {...props} />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
