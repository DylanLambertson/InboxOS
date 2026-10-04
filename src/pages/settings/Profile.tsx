import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Users } from "lucide-react";
import { toast } from "sonner";
import type { Me, Preferences } from "@shared/types";
import { api, errorMessage } from "@/lib/api";
import { useBrand } from "@/lib/brand";
import { useMe } from "@/lib/queries";
import { useFeature } from "@/lib/workspace";
import { RichTextField } from "@/components/compose/Editor";
import { EnforcedSignature } from "@/components/compose/DlpDialog";
import { useOrgSignature } from "@/lib/outbound";
import { Button, PageHeader, Section, Select, Spinner, Switch } from "@/components/ui/primitives";
import { DigestSettings } from "./DigestSettings";
import { PushSettings } from "./PushSettings";
import { ProfileCard } from "./profile/ProfileCard";

const MODE_LABEL = { system: "match system", light: "light", dark: "dark" } as const;
const DENSITY_LABEL = { compact: "compact", comfortable: "comfortable", spacious: "spacious" } as const;

function Row({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1 basis-56">
        <p className="text-[13px] font-medium">{title}</p>
        {description && <p className="mt-0.5 text-xs text-fg-muted">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function ProfileSettings() {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const brand = useBrand();
  const pushOn = useFeature("push");
  const digestOn = useFeature("digest");
  const [signature, setSignature] = useState("");
  // Bumped to remount the editor when its content is replaced from outside.
  const [sigKey, setSigKey] = useState(0);
  const { data: org } = useOrgSignature(undefined);

  useEffect(() => {
    if (me) setSignature(me.signatureHtml);
    // Only when the saved signature changes, not on every preference update.
  }, [me?.signatureHtml]); // eslint-disable-line react-hooks/exhaustive-deps
  // Suggest mode: start an empty signature from the company template.
  useEffect(() => {
    if (me && !me.signatureHtml && org?.mode === "suggest" && org.html) {
      setSignature(org.html);
      setSigKey((k) => k + 1);
    }
  }, [me, org]);

  if (!me) return <Spinner />;

  const patch = async (body: Record<string, unknown>, msg = "Saved") => {
    try {
      const updated = await api.patch<Me>("me", body);
      qc.setQueryData(["me"], updated);
      toast.success(msg);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const setPref = <K extends keyof Preferences>(k: K, v: Preferences[K]) => patch({ preferences: { [k]: v } }, "Preference updated");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Profile & preferences"
        description="How you appear to others and how the app behaves for you."
        actions={
          <Link to="/people" className="inline-flex h-8 items-center gap-1.5 rounded-ui px-3 text-[13px] font-medium text-fg-muted hover:bg-muted hover:text-fg">
            <Users className="size-4" /> People directory
          </Link>
        }
      />

      <ProfileCard me={me} />

      {org?.mode === "enforce" ? (
        <Section title="Signature" description="Your organization sets everyone's signature. It's added to every message you send, filled in with your name, job title and phone above.">
          <div className="rounded-ui border border-line bg-subtle px-3 py-2.5">
            <EnforcedSignature html={org.html} />
          </div>
        </Section>
      ) : (
        <Section title="Personal signature" description="Added to new messages. A mailbox signature (set per mailbox) takes priority when one exists.">
          <RichTextField key={sigKey} value={signature} onChange={setSignature} placeholder="Your name · Title · Phone" minHeight={110} />
          <div className="mt-4 flex justify-end gap-2">
            {org?.mode === "suggest" && org.html && (
              <Button variant="secondary" onClick={() => (setSignature(org.html), setSigKey((k) => k + 1))}>
                Use company signature
              </Button>
            )}
            <Button variant="primary" onClick={() => patch({ signatureHtml: signature === "<p></p>" ? "" : signature }, "Signature saved")}>
              Save signature
            </Button>
          </div>
        </Section>
      )}

      <Section title="Preferences">
        <div className="divide-y divide-line">
          <Row title="Color mode" description="The workspace default is set by your admins; Match system follows your device.">
            <Select value={me.preferences.theme} onChange={(e) => setPref("theme", e.target.value as Preferences["theme"])} className="w-60">
              <option value="workspace">Use workspace default ({MODE_LABEL[brand.theme.defaultMode]})</option>
              <option value="system">Match system</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </Select>
          </Row>
          <Row title="Density" description="Compact shows more messages at once; spacious gives everything more room.">
            <Select value={me.preferences.density} onChange={(e) => setPref("density", e.target.value as Preferences["density"])} className="w-60">
              <option value="workspace">Workspace default ({DENSITY_LABEL[brand.theme.density]})</option>
              <option value="compact">Compact</option>
              <option value="comfortable">Comfortable</option>
              <option value="spacious">Spacious</option>
            </Select>
          </Row>
          <Row title="Undo send" description="Delay sending so you can change your mind.">
            <Select value={me.preferences.undoSendSeconds} onChange={(e) => setPref("undoSendSeconds", Number(e.target.value))} className="w-60">
              {[0, 5, 10, 20, 30].map((s) => (
                <option key={s} value={s}>
                  {s ? `${s} seconds` : "Off"}
                </option>
              ))}
            </Select>
          </Row>
          <Row title="Compose window" description="Open new messages docked or full screen.">
            <Select value={me.preferences.composeMode} onChange={(e) => setPref("composeMode", e.target.value as Preferences["composeMode"])} className="w-60">
              <option value="docked">Docked</option>
              <option value="fullscreen">Full screen</option>
            </Select>
          </Row>
          <Row title="Conversation view" description="Group replies into a single thread.">
            <Switch checked={me.preferences.conversationView} onChange={(v) => setPref("conversationView", v)} label="Conversation view" />
          </Row>
          <Row title="Desktop notifications" description="Get a notification when new mail arrives while this tab is in the background.">
            <Switch
              checked={me.preferences.desktopNotifications}
              onChange={async (v) => {
                if (v && "Notification" in window && Notification.permission !== "granted") {
                  const result = await Notification.requestPermission();
                  if (result !== "granted") return toast.error("Notifications are blocked for this site. Allow them in your browser's site settings.");
                }
                setPref("desktopNotifications", v);
              }}
              label="Desktop notifications"
            />
          </Row>
          <Row title="Mark as read when opened">
            <Switch checked={me.preferences.markReadOnOpen} onChange={(v) => setPref("markReadOnOpen", v)} label="Mark as read when opened" />
          </Row>
          <Row title="Always load remote images" description="Remote images can reveal to senders that you opened their email.">
            <Switch checked={me.preferences.loadRemoteImages} onChange={(v) => setPref("loadRemoteImages", v)} label="Always load remote images" />
          </Row>
        </div>
      </Section>

      {pushOn && <PushSettings me={me} setPref={setPref} />}

      {digestOn && <DigestSettings me={me} />}
    </div>
  );
}
