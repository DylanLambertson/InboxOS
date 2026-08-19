import { AlertTriangle, Ban, CheckCheck, Check, Clock, CircleX, Loader2, MailWarning, Send, ShieldOff } from "lucide-react";
import type { MessageStatus } from "@shared/types";
import { Badge } from "../ui/primitives";

const MAP: Partial<Record<MessageStatus, { label: string; tone: "neutral" | "accent" | "success" | "warning" | "danger"; icon: typeof Check }>> = {
  queued: { label: "Sending", tone: "neutral", icon: Loader2 },
  scheduled: { label: "Scheduled", tone: "accent", icon: Clock },
  sent: { label: "Sent", tone: "neutral", icon: Send },
  delivered: { label: "Delivered", tone: "success", icon: CheckCheck },
  delivery_delayed: { label: "Delayed", tone: "warning", icon: Clock },
  bounced: { label: "Bounced", tone: "danger", icon: MailWarning },
  complained: { label: "Marked as spam", tone: "danger", icon: AlertTriangle },
  failed: { label: "Failed", tone: "danger", icon: CircleX },
  canceled: { label: "Canceled", tone: "neutral", icon: Ban },
  suppressed: { label: "Suppressed", tone: "danger", icon: ShieldOff },
};

export function StatusBadge({ status }: { status: MessageStatus }) {
  const s = MAP[status];
  if (!s) return null;
  const Icon = s.icon;
  return (
    <Badge tone={s.tone}>
      <Icon className={`size-3 ${status === "queued" ? "animate-spin" : ""}`} />
      {s.label}
    </Badge>
  );
}

export const EVENT_LABELS: Record<string, string> = {
  accepted: "Accepted by provider",
  sent: "Sent",
  delivered: "Delivered",
  delivery_delayed: "Delivery delayed",
  bounced: "Bounced",
  complained: "Marked as spam by recipient",
  opened: "Opened",
  clicked: "Link clicked",
  failed: "Failed",
  suppressed: "Suppressed",
  scheduled: "Scheduled",
  received: "Received",
  "received.unrouted": "Received (no matching mailbox)",
};
