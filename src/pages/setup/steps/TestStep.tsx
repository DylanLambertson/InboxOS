import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, CircleDashed, Loader2, Repeat, Send, XCircle } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { useRefreshSetup, type SetupTests, type TestEvent } from "@/lib/setup";
import { Button, cx, Field, Input, Select } from "@/components/ui/primitives";
import { Panel, StepFrame, type StepProps } from "../StepFrame";

const WAIT_MS = 3 * 60_000;
type Tone = "done" | "wait" | "fail" | "idle";

function Stage({ tone, label, detail }: { tone: Tone; label: string; detail?: string }) {
  const Icon = tone === "done" ? CheckCircle2 : tone === "fail" ? XCircle : tone === "wait" ? Loader2 : CircleDashed;
  return (
    <li className="flex items-start gap-2.5">
      <Icon className={cx("mt-0.5 size-4 shrink-0", tone === "done" ? "text-success" : tone === "fail" ? "text-danger" : tone === "wait" ? "animate-spin text-accent" : "text-fg-faint")} />
      <div className="min-w-0">
        <div className={cx("text-[13px]", tone === "idle" ? "text-fg-muted" : "text-fg")}>{label}</div>
        {detail && <div className="text-xs text-fg-muted">{detail}</div>}
      </div>
    </li>
  );
}

const has = (events: TestEvent[], ...types: string[]) => events.find((e) => types.includes(e.type));

function deliveryStage(events: TestEvent[], waiting: boolean): { tone: Tone; label: string; detail?: string } {
  const bad = has(events, "bounced", "failed", "complained", "suppressed");
  if (bad) return { tone: "fail", label: `Delivery ${bad.type}`, detail: bad.detail ?? undefined };
  if (has(events, "delivered")) return { tone: "done", label: "Delivered" };
  if (has(events, "delivery_delayed")) return { tone: "wait", label: "Delivery delayed; Resend keeps trying" };
  return waiting ? { tone: "wait", label: "Waiting for a delivery update…", detail: "Arrives through the webhook." } : { tone: "idle", label: "No delivery update yet" };
}

export function TestStep({ setup, next, skip, back }: StepProps) {
  const refresh = useRefreshSetup();
  const boxes = setup.mailboxes;
  const [from, setFrom] = useState(boxes[0]?.id ?? "");
  const [to, setTo] = useState(setup.me.email);
  const [busy, setBusy] = useState<"send" | "loop" | null>(null);
  const tests = useQuery({
    queryKey: ["setup-tests"],
    queryFn: () => api.get<SetupTests>("admin/setup/test"),
    refetchInterval: (q) => {
      const d = q.state.data;
      const recent = (at?: string) => !!at && Date.now() - Date.parse(at) < WAIT_MS;
      const loopPending = d?.loopback && !d.loopback.arrived && !d.loopback.error && recent(d.loopback.at);
      const sendPending = d?.send && !d.send.error && !has(d.send.events, "delivered", "bounced", "failed") && recent(d.send.at);
      return loopPending || sendPending ? 3000 : false;
    },
  });
  const t = tests.data;
  const ready = setup.provider.apiKey.configured && boxes.length > 0;

  const run = async (kind: "send" | "loop") => {
    setBusy(kind);
    try {
      if (kind === "send") await api.post("admin/setup/test/send", { mailboxId: from, to: to.trim() });
      else await api.post("admin/setup/test/loopback", { mailboxId: from });
      toast.success(kind === "send" ? "Test email sent" : "Test message on its way");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
      await Promise.all([tests.refetch(), refresh()]);
    }
  };

  const lb = t?.loopback;
  const lbWaiting = !!lb && !lb.arrived && !lb.error && Date.now() - Date.parse(lb.at) < WAIT_MS;
  const lbTimedOut = !!lb && !lb.arrived && !lb.error && !lbWaiting;
  // Re-render when the wait runs out, so the troubleshooting tips appear.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!lbWaiting || !lb) return;
    const t = setTimeout(() => tick((n) => n + 1), Date.parse(lb.at) + WAIT_MS - Date.now() + 200);
    return () => clearTimeout(t);
  }, [lbWaiting, lb]);
  const arrivedAt = lb?.arrived?.at;
  useEffect(() => {
    if (arrivedAt && setup.steps.test !== "done") void refresh();
  }, [arrivedAt]);

  return (
    <StepFrame
      title="Send a test"
      description="Check both directions: a message out to an address you can read, and a message from a mailbox to itself that has to come back in through the webhook."
      onBack={back}
      onSkip={setup.steps.test === "done" ? undefined : skip}
      onContinue={next}
      continueDisabled={setup.steps.test !== "done"}
    >
      {!ready && <p className="rounded-ui bg-subtle px-3 py-2.5 text-[13px] text-fg-muted">Connect the email provider and create a mailbox first. You can come back to this step any time.</p>}

      <Field label="Send from">
        <Select value={from} onChange={(e) => setFrom(e.target.value)} disabled={!boxes.length}>
          {boxes.map((b) => (
            <option key={b.id} value={b.id}>
              {b.address}
            </option>
          ))}
        </Select>
      </Field>

      <Panel title="Outgoing" description="Sends a short test email.">
        <div className="flex gap-2">
          <Input type="email" aria-label="Send the test to" value={to} onChange={(e) => setTo(e.target.value)} placeholder="you@gmail.com" />
          <Button icon={<Send className="size-4" />} loading={busy === "send"} disabled={!ready || !to.includes("@")} onClick={() => run("send")}>
            Send
          </Button>
        </div>
        {t?.send && (
          <ul className="mt-4 space-y-2.5">
            <Stage tone={t.send.error ? "fail" : "done"} label={t.send.error ? "Resend refused the message" : `Accepted by Resend for ${t.send.to}`} detail={t.send.error} />
            {!t.send.error && <Stage {...deliveryStage(t.send.events, Date.now() - Date.parse(t.send.at) < WAIT_MS)} />}
          </ul>
        )}
      </Panel>

      <Panel title="Round trip" description="Sends from the mailbox to itself and waits for it to arrive. Proves DNS, the webhook and routing all work.">
        <Button icon={<Repeat className="size-4" />} loading={busy === "loop"} disabled={!ready || lbWaiting} onClick={() => run("loop")}>
          {lb ? "Run again" : "Start round trip"}
        </Button>
        {lb && (
          <ul className="mt-4 space-y-2.5" aria-live="polite">
            <Stage tone={lb.error ? "fail" : "done"} label={lb.error ? "Resend refused the message" : `Sent to ${lb.address}`} detail={lb.error} />
            {!lb.error && (
              <Stage
                tone={lb.arrived ? (lb.arrived.unrouted ? "fail" : "done") : lbWaiting ? "wait" : "fail"}
                label={lb.arrived ? (lb.arrived.unrouted ? "Arrived, but no mailbox matched" : "Arrived in the inbox") : lbWaiting ? "Waiting for it to arrive…" : "It hasn't arrived"}
                detail={lb.arrived?.unrouted ? "It's in Admin → All traffic → Unrouted. Check the mailbox address." : lb.arrived ? `${Math.max(1, Math.round((Date.parse(lb.arrived.at) - Date.parse(lb.at)) / 1000))} seconds round trip.` : undefined}
              />
            )}
          </ul>
        )}
        {lbTimedOut && (
          <div className="mt-4 rounded-ui bg-subtle px-3 py-2.5 text-[13px] text-fg-muted">
            <p className="font-medium text-fg">Things to check</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              <li>The domain's receiving MX record is in place and shows Found on the Domains step.</li>
              <li>Receiving is turned on for the domain, and the webhook is connected.</li>
              <li>APP_URL is the public https address of this app, so Resend can reach the webhook.</li>
              <li>DNS changes can take up to an hour; try again later.</li>
            </ul>
          </div>
        )}
      </Panel>
    </StepFrame>
  );
}
