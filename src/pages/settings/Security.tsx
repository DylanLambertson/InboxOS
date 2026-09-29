import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { Copy, Download, Laptop, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { parseUserAgent, relativeTime } from "@/lib/format";
import { useMe } from "@/lib/queries";
import { Badge, Button, Field, Input, PageHeader, Section } from "@/components/ui/primitives";
import { Modal, useConfirm } from "@/components/ui/overlay";
import { PasskeysSection } from "./Passkeys";

interface SessionInfo {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

function PasswordSection({ hasPassword }: { hasPassword: boolean }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  return (
    <Section title={hasPassword ? "Password" : "Set a password"} description={hasPassword ? "Changing your password signs you out everywhere else." : "Add a password so you can sign in without Google."}>
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api.post("me/password", { current, next });
            toast.success("Password updated");
            setCurrent("");
            setNext("");
            qc.invalidateQueries({ queryKey: ["me"] });
          } catch (err) {
            toast.error(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {hasPassword && (
          <Field label="Current password">
            <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
          </Field>
        )}
        <Field label="New password" hint="10+ characters, mixing letters, numbers and symbols.">
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required />
        </Field>
        <div className="flex items-end sm:col-span-2 sm:justify-end">
          <Button type="submit" variant="primary" loading={busy}>
            {hasPassword ? "Change password" : "Set password"}
          </Button>
        </div>
      </form>
    </Section>
  );
}

function TwoFactorSection({ enabled }: { enabled: boolean }) {
  const qc = useQueryClient();
  const [setup, setSetup] = useState<{ secret: string; uri: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    try {
      const r = await api.post<{ secret: string; uri: string }>("me/2fa/setup");
      setSetup({ ...r, qr: await QRCode.toDataURL(r.uri, { margin: 1, width: 200 }) });
      setCode("");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const enable = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ recoveryCodes: string[] }>("me/2fa/enable", { code });
      setSetup(null);
      setCodes(r.recoveryCodes);
      qc.invalidateQueries({ queryKey: ["me"] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const disable = async () => {
    setBusy(true);
    try {
      await api.post("me/2fa/disable", { code });
      setDisableOpen(false);
      qc.invalidateQueries({ queryKey: ["me"] });
      toast.success("Two-factor authentication turned off");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Two-factor authentication"
      description="Require a code from an authenticator app (1Password, Google Authenticator, Authy…) when you sign in."
      actions={enabled ? <Badge tone="success"><ShieldCheck className="size-3" /> On</Badge> : <Badge>Off</Badge>}
    >
      {enabled ? (
        <Button variant="secondary" onClick={() => (setCode(""), setDisableOpen(true))}>
          Turn off
        </Button>
      ) : setup ? (
        <div className="flex flex-col gap-6 sm:flex-row">
          <img src={setup.qr} alt="QR code for your authenticator app" className="size-44 shrink-0 rounded-ui border border-line bg-white p-2" />
          <div className="flex-1 space-y-4">
            <ol className="list-decimal space-y-1 pl-4 text-[13px] text-fg-muted">
              <li>Scan the QR code with your authenticator app.</li>
              <li>Enter the 6-digit code it shows.</li>
            </ol>
            <p className="text-xs text-fg-muted">
              Can't scan? Enter this key: <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] break-all text-fg">{setup.secret}</code>
            </p>
            <div className="flex gap-2">
              <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" inputMode="numeric" autoComplete="one-time-code" className="max-w-40 font-mono tracking-widest" autoFocus />
              <Button variant="primary" onClick={enable} loading={busy} disabled={code.length < 6}>
                Verify & turn on
              </Button>
              <Button variant="ghost" onClick={() => setSetup(null)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <Button variant="primary" onClick={start}>
          Set up two-factor
        </Button>
      )}

      <Modal
        open={!!codes}
        onClose={() => setCodes(null)}
        title="Save your recovery codes"
        description="Each code works once if you lose access to your authenticator app. Store them somewhere safe — they won't be shown again."
        footer={<Button variant="primary" onClick={() => setCodes(null)}>I've saved them</Button>}
      >
        <div className="grid grid-cols-2 gap-2 rounded-ui bg-subtle p-4 font-mono text-[13px]">
          {codes?.map((c) => <span key={c}>{c}</span>)}
        </div>
        <div className="mt-3 flex gap-2">
          <Button size="sm" icon={<Copy className="size-3.5" />} onClick={() => (navigator.clipboard.writeText(codes!.join("\n")), toast.success("Copied"))}>
            Copy
          </Button>
          <Button
            size="sm"
            icon={<Download className="size-3.5" />}
            onClick={() => {
              const a = document.createElement("a");
              a.href = URL.createObjectURL(new Blob([codes!.join("\n")], { type: "text/plain" }));
              a.download = "recovery-codes.txt";
              a.click();
            }}
          >
            Download
          </Button>
        </div>
      </Modal>
      <Modal
        open={disableOpen}
        onClose={() => setDisableOpen(false)}
        title="Turn off two-factor?"
        description="Enter a current code from your authenticator app to confirm."
        width={400}
        footer={
          <>
            <Button onClick={() => setDisableOpen(false)}>Cancel</Button>
            <Button variant="danger" onClick={disable} loading={busy} disabled={code.length < 6}>
              Turn off
            </Button>
          </>
        }
      >
        <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" inputMode="numeric" className="font-mono tracking-widest" autoFocus />
      </Modal>
    </Section>
  );
}

export function SecuritySettings() {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [params] = useSearchParams();
  const { data: sessions = [], refetch } = useQuery({ queryKey: ["sessions"], queryFn: () => api.get<SessionInfo[]>("me/sessions") });
  const { data: options } = useQuery({ queryKey: ["auth-options"], queryFn: () => api.get<{ google: boolean }>("/api/auth/options") });

  useEffect(() => {
    if (params.get("linked")) toast.success("Google account linked");
    if (params.get("error") === "google_in_use") toast.error("That Google account is already linked to another user.");
  }, [params]);

  if (!me) return null;
  return (
    <div className="space-y-6">
      <PageHeader title="Security" description="Protect your account and review where you're signed in." />
      <PasskeysSection />
      <TwoFactorSection enabled={me.totpEnabled} />
      <PasswordSection hasPassword={me.hasPassword} />

      {(options?.google || me.googleLinked) && (
        <Section title="Google sign-in" description="Sign in with your Google account instead of a password." actions={me.googleLinked ? <Badge tone="success">Linked</Badge> : undefined}>
          {me.googleLinked ? (
            <Button
              onClick={async () => {
                try {
                  await api.post("me/google/unlink");
                  qc.invalidateQueries({ queryKey: ["me"] });
                  toast.success("Google account unlinked");
                } catch (e) {
                  toast.error(errorMessage(e));
                }
              }}
            >
              Unlink Google
            </Button>
          ) : (
            <a href="/api/auth/google/start?mode=link">
              <Button>Link Google account</Button>
            </a>
          )}
        </Section>
      )}

      <Section
        title="Active sessions"
        description="Devices currently signed in to your account."
        actions={
          sessions.length > 1 && (
            <Button
              size="sm"
              onClick={async () => {
                if (!(await confirm({ title: "Sign out other sessions?", confirmLabel: "Sign out others" }))) return;
                await api.post("me/sessions/revoke-others");
                refetch();
                toast.success("Signed out of other sessions");
              }}
            >
              Sign out others
            </Button>
          )
        }
      >
        <div className="divide-y divide-line">
          {sessions.map((s) => (
            <div key={s.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
              <Laptop className="size-5 text-fg-muted" />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium">
                  {parseUserAgent(s.userAgent)} {s.current && <Badge tone="accent" className="ml-1">This device</Badge>}
                </p>
                <p className="text-xs text-fg-muted">
                  {s.ip ?? "Unknown IP"} · Active {relativeTime(s.lastSeenAt)} · Signed in {relativeTime(s.createdAt)}
                </p>
              </div>
              {!s.current && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await api.del(`me/sessions/${s.id}`);
                    refetch();
                  }}
                >
                  Sign out
                </Button>
              )}
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
