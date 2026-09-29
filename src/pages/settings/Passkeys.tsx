import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FingerprintPattern, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError, errorMessage } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { addPasskey, isPasskeyCancel, passkeysSupported } from "@/lib/passkeys";
import { Badge, Button, Field, IconButton, Input, Section } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlay";

interface PasskeyInfo {
  id: string;
  name: string;
  host: string;
  synced: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  usableHere: boolean;
}

interface PasskeyList {
  passkeys: PasskeyInfo[];
  /** Host passkeys are bound to on this address, or null when they can't be used here. */
  host: string | null;
  recentAuth: boolean;
  reauth: { password: boolean; totp: boolean };
  suggestedName: string;
  max: number;
}

type Reauth = { password?: string; code?: string };

/** Password or 2FA code re-check, shown when the session isn't fresh enough to change passkeys. */
function ReauthFields({ list, value, onChange }: { list: PasskeyList; value: Reauth; onChange: (v: Reauth) => void }) {
  if (list.reauth.password) {
    return (
      <Field label="Your password" hint="To confirm it's you.">
        <Input type="password" value={value.password ?? ""} onChange={(e) => onChange({ password: e.target.value })} autoComplete="current-password" />
      </Field>
    );
  }
  if (list.reauth.totp) {
    return (
      <Field label="Two-factor code" hint="From your authenticator app, to confirm it's you.">
        <Input value={value.code ?? ""} onChange={(e) => onChange({ code: e.target.value })} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" className="font-mono tracking-widest" />
      </Field>
    );
  }
  return <p className="text-[13px] text-fg-muted">To confirm it's you, sign out and sign back in, then try again within 10 minutes.</p>;
}

const hasReauth = (r: Reauth) => !!(r.password || (r.code && r.code.replace(/\s/g, "").length >= 6));

export function PasskeysSection() {
  const qc = useQueryClient();
  const { data: list, refetch } = useQuery({ queryKey: ["passkeys"], queryFn: () => api.get<PasskeyList>("me/passkeys") });
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<PasskeyInfo | null>(null);
  const [removing, setRemoving] = useState<PasskeyInfo | null>(null);
  const [name, setName] = useState("");
  const [reauth, setReauth] = useState<Reauth>({});
  const [needReauth, setNeedReauth] = useState(false);
  const [busy, setBusy] = useState(false);
  const supported = passkeysSupported();

  if (!list) return null;
  const askReauth = needReauth || !list.recentAuth;
  const refresh = () => (refetch(), qc.invalidateQueries({ queryKey: ["me"] }));
  const open = (kind: "add" | "remove", pk?: PasskeyInfo) => {
    setReauth({});
    setNeedReauth(false);
    if (kind === "add") (setName(list.suggestedName), setAdding(true));
    else setRemoving(pk ?? null);
  };
  /** Run an action; a 428 means the server wants the password/code re-check first. */
  const run = async (fn: () => Promise<void>, ok: string, close: () => void) => {
    setBusy(true);
    try {
      await fn();
      close();
      refresh();
      toast.success(ok);
    } catch (err) {
      if (err instanceof ApiError && err.status === 428) setNeedReauth(true);
      if (!isPasskeyCancel(err)) toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Passkeys"
      description={
        <>
          Sign in with Face ID, Touch ID, your fingerprint, a PIN or a security key — no password or code needed. A passkey only works on the address where you add it
          {list.host ? <> (you're on <span className="font-medium text-fg">{list.host}</span>)</> : null}.
        </>
      }
      actions={list.passkeys.length ? <Badge tone="success">{list.passkeys.length} added</Badge> : undefined}
    >
      {list.passkeys.length > 0 && (
        <div className="mb-4 divide-y divide-line">
          {list.passkeys.map((p) => (
            <div key={p.id} className="flex items-center gap-3 py-3 first:pt-0">
              <FingerprintPattern className="size-5 shrink-0 text-fg-muted" />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium">
                  <span className="truncate">{p.name}</span>
                  {p.usableHere ? <Badge tone="accent">This address</Badge> : <Badge>{p.host}</Badge>}
                  {p.synced && <Badge>Synced</Badge>}
                </p>
                <p className="text-xs text-fg-muted">
                  Added {relativeTime(p.createdAt)} · {p.lastUsedAt ? `Last used ${relativeTime(p.lastUsedAt)}` : "Never used"}
                  {!p.usableHere && ` · Works on ${p.host} only`}
                </p>
              </div>
              <IconButton label="Rename" onClick={() => (setName(p.name), setRenaming(p))}>
                <Pencil className="size-4" />
              </IconButton>
              <IconButton label="Remove" onClick={() => open("remove", p)}>
                <Trash2 className="size-4" />
              </IconButton>
            </div>
          ))}
        </div>
      )}
      {!supported ? (
        <p className="text-[13px] text-fg-muted">This browser doesn't support passkeys.</p>
      ) : !list.host ? (
        <p className="text-[13px] text-fg-muted">Passkeys can't be added on this address. Open the app at its usual mail.… address.</p>
      ) : (
        <Button variant={list.passkeys.length ? "secondary" : "primary"} icon={<FingerprintPattern className="size-4" />} onClick={() => open("add")} disabled={list.passkeys.length >= list.max}>
          Add a passkey
        </Button>
      )}

      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="Add a passkey"
        description={`Your device will ask for Face ID, Touch ID, your fingerprint or PIN. This passkey will work on ${list.host ?? "this address"} only.`}
        width={420}
        footer={
          <>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!name.trim() || (askReauth && !hasReauth(reauth))}
              onClick={() => run(() => addPasskey(name.trim(), askReauth ? reauth : {}), "Passkey added", () => setAdding(false))}
            >
              Continue
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Name" hint="So you can tell your passkeys apart, e.g. “Work MacBook”.">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />
          </Field>
          {askReauth && <ReauthFields list={list} value={reauth} onChange={setReauth} />}
        </div>
      </Modal>

      <Modal
        open={!!renaming}
        onClose={() => setRenaming(null)}
        title="Rename passkey"
        width={400}
        footer={
          <>
            <Button onClick={() => setRenaming(null)}>Cancel</Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!name.trim()}
              onClick={() => run(() => api.patch(`me/passkeys/${renaming!.id}`, { name: name.trim() }), "Passkey renamed", () => setRenaming(null))}
            >
              Save
            </Button>
          </>
        }
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />
      </Modal>

      <Modal
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={`Remove “${removing?.name ?? ""}”?`}
        description="You won't be able to sign in with this passkey any more. Also delete it from your device or password manager."
        width={420}
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>Cancel</Button>
            <Button
              variant="danger"
              loading={busy}
              disabled={askReauth && !hasReauth(reauth)}
              onClick={() => run(() => api.del(`me/passkeys/${removing!.id}`, askReauth ? reauth : {}), "Passkey removed", () => setRemoving(null))}
            >
              Remove
            </Button>
          </>
        }
      >
        {askReauth && <ReauthFields list={list} value={reauth} onChange={setReauth} />}
      </Modal>
    </Section>
  );
}
