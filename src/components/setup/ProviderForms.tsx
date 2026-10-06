import { useState, type FormEvent } from "react";
import { ExternalLink, KeyRound, Webhook } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { useRefreshSetup, type ProviderStatusData } from "@/lib/setup";
import { Button, Field, Input } from "@/components/ui/primitives";
import { CopyField } from "./StatusBadges";

/** Paste a Resend API key; it's checked with Resend before it's saved. */
export function ApiKeyForm({ onSaved, submitLabel = "Connect", autoFocus }: { onSaved?: () => void; submitLabel?: string; autoFocus?: boolean }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useRefreshSetup();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.put<ProviderStatusData & { domainCount: number; overriddenByEnv: boolean }>("admin/setup/provider", { apiKey: key.trim() });
      setKey("");
      toast.success(r.domainCount ? `Connected. Your Resend account has ${r.domainCount} domain${r.domainCount === 1 ? "" : "s"}.` : "Connected to Resend.");
      if (r.overriddenByEnv) toast.info("A RESEND_API_KEY Worker secret is also set; it takes priority over the key saved here.");
      await refresh();
      onSaved?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Resend API key" htmlFor="resend-key" error={error} hint="Checked with Resend, then stored encrypted. It's never shown again in full.">
        <div className="flex gap-2">
          <Input
            id="resend-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="re_…"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="font-mono"
            autoFocus={autoFocus}
          />
          <Button type="submit" variant="primary" loading={busy} disabled={!key.trim()} icon={<KeyRound className="size-4" />}>
            {submitLabel}
          </Button>
        </div>
      </Field>
    </form>
  );
}

/** Where to get a key, with the exact permission needed. */
export function ApiKeyHelp() {
  return (
    <ol className="list-decimal space-y-1.5 pl-5 text-[13px] text-fg-muted marker:text-fg-faint">
      <li>
        Sign in to Resend (or{" "}
        <a className="font-medium text-accent hover:underline" href="https://resend.com/signup" target="_blank" rel="noreferrer">
          create a free account
        </a>
        ).
      </li>
      <li>
        Open{" "}
        <a className="inline-flex items-center gap-1 font-medium text-accent hover:underline" href="https://resend.com/api-keys" target="_blank" rel="noreferrer">
          API Keys <ExternalLink className="size-3" />
        </a>{" "}
        and click <b className="text-fg">Create API key</b>.
      </li>
      <li>
        Set <b className="text-fg">Permission</b> to <b className="text-fg">Full access</b>. A "Sending access" key can't read incoming mail or set up domains.
      </li>
      <li>Copy the key (it starts with re_) and paste it here.</li>
    </ol>
  );
}

/** Paste a webhook signing secret by hand, for a webhook created in the Resend dashboard. */
export function WebhookSecretForm({ onSaved }: { onSaved?: () => void }) {
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useRefreshSetup();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.put("admin/setup/webhook", { secret: secret.trim() });
      setSecret("");
      toast.success("Signing secret saved");
      await refresh();
      onSaved?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit}>
      <Field label="Signing secret" htmlFor="whsec" error={error}>
        <div className="flex gap-2">
          <Input id="whsec" type="password" autoComplete="off" spellCheck={false} placeholder="whsec_…" value={secret} onChange={(e) => setSecret(e.target.value)} className="font-mono" />
          <Button type="submit" loading={busy} disabled={!secret.trim()}>
            Save
          </Button>
        </div>
      </Field>
    </form>
  );
}

/** The manual route for the webhook, step by step. */
export function ManualWebhookSteps({ endpoint }: { endpoint: string }) {
  return (
    <div className="space-y-3">
      <ol className="list-decimal space-y-1.5 pl-5 text-[13px] text-fg-muted marker:text-fg-faint">
        <li>
          In Resend, open{" "}
          <a className="font-medium text-accent hover:underline" href="https://resend.com/webhooks" target="_blank" rel="noreferrer">
            Webhooks
          </a>{" "}
          and click <b className="text-fg">Add webhook</b>.
        </li>
        <li>Paste this endpoint URL:</li>
      </ol>
      <CopyField value={endpoint} />
      <ol start={3} className="list-decimal space-y-1.5 pl-5 text-[13px] text-fg-muted marker:text-fg-faint">
        <li>
          Select <b className="text-fg">all email events</b> (including email.received) and save.
        </li>
        <li>Open the new webhook, copy its signing secret (starts with whsec_) and paste it below.</li>
      </ol>
      <WebhookSecretForm />
    </div>
  );
}

/** Register the webhook in Resend automatically and keep its signing secret. */
export function AutoWebhookButton({ disabled, label = "Set up automatically", onDone, size }: { disabled?: boolean; label?: string; onDone?: () => void; size?: "sm" | "md" }) {
  const [busy, setBusy] = useState(false);
  const refresh = useRefreshSetup();
  return (
    <Button
      variant="primary"
      size={size}
      icon={<Webhook className="size-4" />}
      loading={busy}
      disabled={disabled}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await api.post<{ replaced: number }>("admin/setup/webhook");
          toast.success(r.replaced ? "Webhook replaced and connected" : "Webhook connected");
          await refresh();
          onDone?.();
        } catch (err) {
          toast.error(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {label}
    </Button>
  );
}
