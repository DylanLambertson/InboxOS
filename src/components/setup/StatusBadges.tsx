import { useState } from "react";
import { AlertTriangle, Check, CheckCircle2, CircleDashed, CircleHelp, Copy, Loader2, XCircle } from "lucide-react";
import { toast } from "sonner";
import type { CheckState } from "@shared/dns";
import { Badge, cx } from "@/components/ui/primitives";

type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

/** Resend's domain statuses, in plain words. */
const DOMAIN_STATUS: Record<string, { label: string; tone: Tone; hint: string }> = {
  verified: { label: "Verified", tone: "success", hint: "Ready to send." },
  pending: { label: "Checking DNS", tone: "warning", hint: "Resend is looking for the records. This can take a few minutes after you add them." },
  not_started: { label: "Waiting for DNS", tone: "neutral", hint: "Add the records below, then verify." },
  partially_verified: { label: "Partly verified", tone: "warning", hint: "Sending or receiving is verified, the other is still pending." },
  partially_failed: { label: "Partly failed", tone: "danger", hint: "Sending or receiving couldn't be verified. Check the records marked below." },
  failed: { label: "Failed", tone: "danger", hint: "Resend couldn't find the records within 72 hours. Fix them, then verify again." },
  temporary_failure: { label: "Records missing", tone: "danger", hint: "A record that used to be there can't be found right now. Resend keeps checking for 72 hours." },
};

export function domainStatusInfo(status: string | null | undefined) {
  if (!status) return { label: "Not connected", tone: "neutral" as Tone, hint: "Not in Resend yet." };
  return DOMAIN_STATUS[status] ?? { label: status.replace(/_/g, " "), tone: "neutral" as Tone, hint: "" };
}

/** A domain's provider status as a badge (reused on Domains, Setup and Health). */
export function DomainStatusBadge({ status, className }: { status: string | null | undefined; className?: string }) {
  const info = domainStatusInfo(status);
  const Icon = info.tone === "success" ? CheckCircle2 : info.tone === "danger" ? XCircle : info.tone === "warning" ? Loader2 : CircleDashed;
  return (
    <Badge tone={info.tone} className={className}>
      <Icon className={cx("size-3", info.tone === "warning" && "animate-spin [animation-duration:2.5s]")} aria-hidden />
      {info.label}
    </Badge>
  );
}

const RECORD_STATE: Record<CheckState, { label: string; tone: Tone; icon: typeof Check }> = {
  found: { label: "Found", tone: "success", icon: CheckCircle2 },
  missing: { label: "Not found", tone: "neutral", icon: CircleDashed },
  mismatched: { label: "Needs a fix", tone: "danger", icon: AlertTriangle },
  unknown: { label: "Couldn't check", tone: "warning", icon: CircleHelp },
};

/** Live DNS state of one record. */
export function RecordStateBadge({ state }: { state: CheckState }) {
  const s = RECORD_STATE[state];
  return (
    <Badge tone={s.tone}>
      <s.icon className="size-3" aria-hidden />
      {s.label}
    </Badge>
  );
}

/** Small button that copies a value and confirms with a check mark. */
export function CopyButton({ value, label = "Copy", className }: { value: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          toast.error("Couldn't copy. Select the text and copy it instead.");
        }
      }}
      className={cx(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-ui-sm text-fg-muted transition-colors hover:bg-muted hover:text-fg",
        done && "text-success hover:text-success",
        className,
      )}
    >
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

/** A value in monospace with a copy button, for keys, URLs and DNS values. */
export function CopyField({ value, className }: { value: string; className?: string }) {
  return (
    <div className={cx("flex min-w-0 items-center gap-1 rounded-ui border border-line bg-subtle py-1 pr-1 pl-3", className)}>
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg" title={value}>
        {value}
      </code>
      <CopyButton value={value} />
    </div>
  );
}
