import { Link, useNavigate } from "react-router";
import { ArrowRight, Check, Minus, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { ESSENTIAL_STEPS, SETUP_STEPS, STEP_INFO, type SetupStepId, type StepState } from "@shared/setup";
import { api, errorMessage } from "@/lib/api";
import { useMe } from "@/lib/queries";
import { useAdminSetup, useRefreshSetup } from "@/lib/setup";
import { ProviderStatusCard } from "@/components/setup/ProviderStatus";
import { Badge, Button, cx, LoadError, PageHeader, Section, Spinner } from "@/components/ui/primitives";

const STATE_BADGE: Record<StepState, { label: string; tone: "success" | "neutral" | "warning" }> = {
  done: { label: "Done", tone: "success" },
  skipped: { label: "Skipped", tone: "neutral" },
  todo: { label: "To do", tone: "warning" },
};

/** Where an admin who isn't the owner can handle a step themselves. */
const ADMIN_LINK: Partial<Record<SetupStepId, string>> = {
  brand: "/admin/branding",
  domains: "/admin/domains",
  mailboxes: "/admin/mailboxes",
  team: "/admin/users",
};

/** Admin → Setup: live status of every setup step, and the email provider connection. */
export function AdminSetup() {
  const { data, error, isLoading, refetch } = useAdminSetup();
  const { data: me } = useMe();
  const owner = me?.role === "owner";
  const refresh = useRefreshSetup();
  const navigate = useNavigate();

  if (isLoading) return <Spinner className="mx-auto mt-16 size-5" />;
  if (error || !data) return <LoadError error={error} onRetry={() => refetch()} />;
  const steps = SETUP_STEPS.filter((s) => s !== "done" && s !== "owner");
  const missing = ESSENTIAL_STEPS.filter((s) => data.steps[s] !== "done");

  const reopen = async () => {
    try {
      await api.put("admin/setup/progress", { complete: false, dismiss: false });
      await refresh();
      toast.success("The setup reminder is back on");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Setup"
        description={missing.length ? "A few things still need doing before mail can flow." : "Everything needed for sending and receiving is in place."}
        actions={
          owner && (
            <Button variant="primary" icon={<Wand2 className="size-4" />} onClick={() => navigate(`/setup/${data.completed ? "useCase" : data.nextStep}`)}>
              {data.completed ? "Open setup wizard" : "Continue setup"}
            </Button>
          )
        }
      />

      <Section
        title="Progress"
        description={`${data.progress}% done`}
        actions={
          owner && (data.completed || data.dismissed) ? (
            <Button size="sm" variant="ghost" onClick={reopen}>
              Show the reminder again
            </Button>
          ) : undefined
        }
      >
        <div className="mb-5 h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${data.progress}%` }} />
        </div>
        <ul className="divide-y divide-line">
          {steps.map((s) => {
            const state = data.steps[s];
            const b = STATE_BADGE[state];
            const href = owner ? `/setup/${s}` : ADMIN_LINK[s];
            return (
              <li key={s} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                <span className={cx("flex size-6 shrink-0 items-center justify-center rounded-full", state === "done" ? "bg-success text-white" : "bg-muted text-fg-faint")}>
                  {state === "done" ? <Check className="size-3.5" /> : <Minus className="size-3.5" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-fg">{STEP_INFO[s].label}</span>
                  <span className="block text-xs text-fg-muted">
                    {STEP_INFO[s].hint}
                    {ESSENTIAL_STEPS.includes(s) && state !== "done" ? " · needed for mail to work" : ""}
                  </span>
                </span>
                <Badge tone={b.tone}>{b.label}</Badge>
                {href && (
                  <Link to={href} className="flex items-center gap-1 text-xs font-medium text-accent hover:underline" aria-label={`Open ${STEP_INFO[s].label}`}>
                    Open <ArrowRight className="size-3" />
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      </Section>

      <ProviderStatusCard />

      <Section title="Recovery" description="Locked out of the owner account?">
        <p className="text-[13px] text-fg-muted">
          Anyone with access to the deployment can reset an owner's password from a terminal with <code className="text-xs text-fg">npm run bootstrap:remote -- --email you@example.com</code>.
        </p>
      </Section>
    </div>
  );
}
