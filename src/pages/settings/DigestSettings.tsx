import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BellRing, MailCheck, X } from "lucide-react";
import { toast } from "sonner";
import { DIGEST_HOURS, type Me } from "@shared/types";
import { api, errorMessage } from "@/lib/api";
import { Badge, Button, Field, Input, Section, Select, Switch } from "@/components/ui/primitives";
import { useConfirm } from "@/components/ui/overlay";

const EVERY: Record<number, string> = { 1: "Every hour", 3: "Every 3 hours", 5: "Every 5 hours", 12: "Twice a day", 24: "Once a day" };

/** Settings → Profile: unread-mail reminders sent to a personal (non-company) address. */
export function DigestSettings({ me }: { me: Me }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const update = async (body: { enabled?: boolean; hours?: number }) => {
    try {
      const next = await api.patch<Me>("me/digest", body);
      qc.setQueryData(["me"], next);
      if (body.enabled !== undefined) toast.success(body.enabled ? "Reminders are on" : "Reminders are off");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const sendConfirmation = async () => {
    setBusy(true);
    try {
      await api.post("me/personal-email", { email: email.trim() });
      setPending(email.trim());
      setEmail("");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!(await confirm({ title: "Remove your personal email?", body: "Reminders stop until you add one again.", confirmLabel: "Remove" }))) return;
    try {
      qc.setQueryData(["me"], await api.del<Me>("me/personal-email"));
      toast.success("Personal email removed");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  if (!me.digestsAllowed) {
    return (
      <Section title="Unread-mail reminders">
        <p className="text-[13px] text-fg-muted">Your organization has turned off reminders to personal email.</p>
      </Section>
    );
  }

  return (
    <Section
      title="Unread-mail reminders"
      description="Get a short email at a personal address (like Gmail or iCloud) listing unread mail in your mailboxes, so you notice it without opening the app."
    >
      <div className="space-y-5">
        <Field label="Personal email">
          {me.personalEmail ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-medium">{me.personalEmail}</span>
              <Badge tone="success">
                <MailCheck className="size-3" /> Confirmed
              </Badge>
              <button onClick={remove} className="ml-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-muted hover:text-fg">
                <X className="size-3" /> Remove
              </button>
            </div>
          ) : (
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (email.trim()) sendConfirmation();
              }}
            >
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@gmail.com" className="min-w-0 flex-1 sm:max-w-xs" />
              <Button type="submit" loading={busy} disabled={!email.trim()}>
                Send confirmation
              </Button>
            </form>
          )}
          {pending && !me.personalEmail && (
            <p className="mt-2 text-xs text-fg-muted">
              We sent a link to <b className="text-fg">{pending}</b>. Open it to confirm, then come back here to turn reminders on.
            </p>
          )}
        </Field>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-[13px] font-medium">
              <BellRing className="size-4 text-fg-muted" /> Email me about unread mail
            </p>
            <p className="text-xs text-fg-muted">
              {!me.personalEmail
                ? "Confirm a personal email first."
                : me.digest.enabled && me.digest.nextAt
                  ? `Next check around ${new Date(me.digest.nextAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Only sent when something new is still unread.`
                  : "Only sent when something new is still unread. Senders and subjects only, never the message itself."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select
              value={me.digest.hours}
              onChange={(e) => update({ hours: Number(e.target.value) })}
              disabled={!me.personalEmail}
              className="w-auto"
              aria-label="How often"
            >
              {DIGEST_HOURS.map((h) => (
                <option key={h} value={h}>
                  {EVERY[h]}
                </option>
              ))}
            </Select>
            <Switch checked={me.digest.enabled} disabled={!me.personalEmail} onChange={(v) => update({ enabled: v })} label="Email me about unread mail" />
          </div>
        </div>
        <p className="text-xs text-fg-faint">In shared mailboxes, “unread” means nobody on the team has opened it yet.</p>
      </div>
    </Section>
  );
}
