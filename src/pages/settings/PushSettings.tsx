import { useEffect, useState } from "react";
import { BellRing, Share, Smartphone } from "lucide-react";
import { toast } from "sonner";
import type { Me } from "@shared/types";
import { api, errorMessage } from "@/lib/api";
import { disablePush, enablePush, getPushState, type PushState } from "@/lib/push";
import { Button, Section, Spinner, Switch } from "@/components/ui/primitives";

const HINT: Record<PushState, string> = {
  on: "This device gets a notification as soon as new mail arrives.",
  off: "Get a notification on this device as soon as new mail arrives, even when the app is closed.",
  denied: "Notifications are blocked for this site. Allow them in your browser or phone settings, then come back.",
  unsupported: "This browser can't receive push notifications.",
  "server-off": "Push notifications aren't set up on this server yet.",
  "needs-install": "On iPhone and iPad, notifications work once the app is on your home screen.",
};

/** Settings → Profile: push notifications for new mail on this device. */
export function PushSettings({ me, setPref }: { me: Me; setPref: (k: "pushShowDetails", v: boolean) => void }) {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getPushState()
      .then(setState)
      .catch(() => setState("unsupported"));
  }, []);

  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      if (on) {
        const next = await enablePush();
        setState(next);
        if (next === "on") toast.success("Notifications are on for this device");
        else if (next === "denied") toast.error("Notifications were blocked. Allow them in your settings.");
      } else {
        await disablePush();
        setState("off");
        toast.success("Notifications are off for this device");
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    try {
      const r = await api.post<{ devices: number }>("push/test");
      toast.success(`Sent to ${r.devices} device${r.devices === 1 ? "" : "s"}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <Section title="Push notifications" description="New-mail alerts on your phone or computer, like a native mail app.">
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-[13px] font-medium">
              <Smartphone className="size-4 text-fg-muted" /> Notifications on this device
            </p>
            <p className="text-xs text-fg-muted">{state ? HINT[state] : "Checking this device…"}</p>
          </div>
          {state === null ? (
            <Spinner className="size-4" />
          ) : (
            <Switch checked={state === "on"} disabled={busy || !["on", "off"].includes(state)} onChange={toggle} label="Notifications on this device" />
          )}
        </div>

        {state === "needs-install" && (
          <p className="flex items-start gap-2 rounded-ui bg-muted px-3 py-2 text-xs text-fg-muted">
            <Share className="mt-0.5 size-3.5 shrink-0" />
            In Safari, tap Share, then Add to Home Screen. Open the app from your home screen, sign in, and turn this on.
          </p>
        )}

        {state === "on" && (
          <Button size="sm" icon={<BellRing className="size-3.5" />} onClick={test}>
            Send a test notification
          </Button>
        )}

        <div className="flex items-center justify-between gap-4 border-t border-line pt-4">
          <div className="min-w-0">
            <p className="text-[13px] font-medium">Show sender and subject</p>
            <p className="text-xs text-fg-muted">Off shows only “New mail in Support” on the lock screen. Message text is never included.</p>
          </div>
          <Switch checked={me.preferences.pushShowDetails} onChange={(v) => setPref("pushShowDetails", v)} label="Show sender and subject" />
        </div>
      </div>
    </Section>
  );
}
