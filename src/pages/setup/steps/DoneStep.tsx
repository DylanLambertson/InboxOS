import { useState } from "react";
import { useNavigate } from "react-router";
import { ArrowRight, Check, Inbox, Minus, PartyPopper } from "lucide-react";
import { toast } from "sonner";
import { ESSENTIAL_STEPS, SETUP_STEPS, STEP_INFO } from "@shared/setup";
import { api, errorMessage } from "@/lib/api";
import { useRefreshSetup } from "@/lib/setup";
import { Button, cx } from "@/components/ui/primitives";
import { Panel, StepFrame, type StepProps } from "../StepFrame";

const NEXT = [
  { to: "/admin/branding", label: "Fine-tune the look", hint: "Fonts, colors, sign-in page and email footer." },
  { to: "/admin/users", label: "Manage people", hint: "Roles, access to shared inboxes, two-factor." },
  { to: "/admin/domains", label: "Domains", hint: "DNS health and more domains." },
  { to: "/settings/profile", label: "Your profile", hint: "Signature, notifications and theme." },
];

export function DoneStep({ setup, back, goto }: StepProps) {
  const navigate = useNavigate();
  const refresh = useRefreshSetup();
  const [busy, setBusy] = useState(false);
  const steps = SETUP_STEPS.filter((s) => s !== "done");
  const missing = ESSENTIAL_STEPS.filter((s) => setup.steps[s] !== "done");

  const finish = async (to: string) => {
    setBusy(true);
    try {
      // Only mark setup finished once mail can actually flow; until then the reminder stays.
      if (!missing.length) await api.put("admin/setup/progress", { complete: true });
      await refresh();
      navigate(to);
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <StepFrame
      title={missing.length ? "Almost there" : "You're all set"}
      description={
        missing.length
          ? "You can start using the app now. Mail won't flow until the steps marked below are done; the reminder in the app brings you back here."
          : "Mail is flowing. Here's what's set up, and where to go next."
      }
      onBack={back}
    >
      {!missing.length && (
        <div className="flex items-center gap-3 rounded-ui-lg bg-accent-soft px-4 py-3 text-[13px] text-accent">
          <PartyPopper className="size-5 shrink-0" /> Setup complete.
        </div>
      )}
      <Panel title="Checklist">
        <ul className="divide-y divide-line">
          {steps.map((s) => {
            const state = setup.steps[s];
            const essential = ESSENTIAL_STEPS.includes(s);
            return (
              <li key={s} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                <span className={cx("flex size-5 shrink-0 items-center justify-center rounded-full", state === "done" ? "bg-success text-white" : "bg-muted text-fg-faint")}>
                  {state === "done" ? <Check className="size-3" /> : <Minus className="size-3" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-fg">{STEP_INFO[s].label}</span>
                  {state !== "done" && <span className="block text-xs text-fg-muted">{essential ? "Needed for mail to work" : "Optional"}</span>}
                </span>
                {state !== "done" && s !== "owner" && (
                  <Button size="xs" variant="ghost" onClick={() => goto(s)}>
                    Finish
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </Panel>

      <div className="grid gap-3 sm:grid-cols-2">
        {NEXT.map((n) => (
          <button
            key={n.to}
            type="button"
            onClick={() => finish(n.to)}
            disabled={busy}
            className="group rounded-ui-lg border border-line bg-surface p-4 text-left shadow-ui-sm transition-colors hover:border-line-strong"
          >
            <span className="flex items-center justify-between text-sm font-medium text-fg">
              {n.label} <ArrowRight className="size-4 text-fg-faint transition-transform group-hover:translate-x-0.5" />
            </span>
            <span className="mt-0.5 block text-[13px] text-fg-muted">{n.hint}</span>
          </button>
        ))}
      </div>

      <div className="flex justify-end">
        <Button variant="primary" icon={<Inbox className="size-4" />} loading={busy} onClick={() => finish("/")}>
          {missing.length ? "Finish for now" : "Open your inbox"}
        </Button>
      </div>
    </StepFrame>
  );
}
