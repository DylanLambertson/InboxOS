import { useState, type FormEvent } from "react";
import { Check, Eye, EyeOff, KeyRound } from "lucide-react";
import type { PublicSetupStatus } from "@shared/setup";
import { api, errorMessage } from "@/lib/api";
import { useBrand } from "@/lib/brand";
import { Button, cx, Field, Input } from "@/components/ui/primitives";
import { Panel, StepFrame } from "../StepFrame";

/** The same rules the server enforces (worker/lib/password.ts). */
export function passwordChecks(pw: string) {
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  return [
    { ok: pw.length >= 10, label: "At least 10 characters" },
    { ok: classes >= 3, label: "Three of: lowercase, uppercase, numbers, symbols" },
  ];
}

function strength(pw: string): { score: number; label: string } {
  if (!pw) return { score: 0, label: "" };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  const score = Math.min(4, (pw.length >= 10 ? 1 : 0) + (pw.length >= 14 ? 1 : 0) + (classes >= 3 ? 1 : 0) + (classes === 4 || pw.length >= 20 ? 1 : 0));
  return { score, label: ["Too short", "Weak", "Okay", "Strong", "Very strong"][score] };
}

function SetupKeyHelp({ source }: { source: PublicSetupStatus["setupKeySource"] }) {
  return (
    <div className="space-y-2 text-[13px] text-fg-muted">
      {source === "SETUP_TOKEN" ? (
        <p>
          It's the <b className="text-fg">SETUP_TOKEN</b> secret set for this deployment.
        </p>
      ) : (
        <p>
          It's the <b className="text-fg">SESSION_SECRET</b> you chose when deploying (<code className="text-xs text-fg">npx wrangler secret put SESSION_SECRET</code>). When running locally, it's
          in your <code className="text-xs text-fg">.dev.vars</code> file.
        </p>
      )}
      <p>
        Cloudflare never shows secrets again. If you don't have it, set a new setup key with <code className="text-xs text-fg">npx wrangler secret put SETUP_TOKEN</code>, then paste that here.
      </p>
      <p className="text-xs text-fg-faint">The key proves you deployed this app, so nobody else can claim it first.</p>
    </div>
  );
}

/** Create the owner account on a brand-new install, then sign in. */
export function OwnerStep({ setupKeySource, onCreated }: { setupKeySource: PublicSetupStatus["setupKeySource"]; onCreated: () => void }) {
  const brand = useBrand();
  const [form, setForm] = useState({ name: "", email: "", password: "", setupKey: "" });
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const checks = passwordChecks(form.password);
  const s = strength(form.password);
  const ready = form.name.trim() && form.email.includes("@") && checks.every((c) => c.ok) && form.setupKey.trim();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/setup/owner", form);
      onCreated();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <StepFrame
      eyebrow="Welcome"
      title={`Let's set up ${brand.productName}`}
      description="First, create your owner account. You'll be able to change everything else, and you can stop and come back at any point."
    >
      <form onSubmit={submit} className="space-y-6">
        <Panel title="Your account">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Your name" htmlFor="owner-name">
              <Input id="owner-name" autoComplete="name" value={form.name} onChange={set("name")} required autoFocus />
            </Field>
            <Field label="Email" htmlFor="owner-email" hint="Any address you can read today. Your work mailbox comes later.">
              <Input id="owner-email" type="email" autoComplete="email" value={form.email} onChange={set("email")} required />
            </Field>
          </div>
          <Field label="Password" htmlFor="owner-password" className="mt-4">
            <div className="relative">
              <Input id="owner-password" type={show ? "text" : "password"} autoComplete="new-password" value={form.password} onChange={set("password")} required className="pr-10" />
              <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? "Hide password" : "Show password"} className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-fg-muted hover:text-fg">
                {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </Field>
          <div className="mt-2.5 flex items-center gap-3" aria-live="polite">
            <div className="flex flex-1 gap-1">
              {[1, 2, 3, 4].map((i) => (
                <span key={i} className={cx("h-1 flex-1 rounded-full transition-colors", i <= s.score ? (s.score <= 1 ? "bg-danger" : s.score === 2 ? "bg-warning" : "bg-success") : "bg-muted")} />
              ))}
            </div>
            <span className="w-20 text-right text-xs text-fg-muted">{s.label}</span>
          </div>
          <ul className="mt-2 space-y-1">
            {checks.map((c) => (
              <li key={c.label} className={cx("flex items-center gap-1.5 text-xs", c.ok ? "text-success" : "text-fg-muted")}>
                <Check className={cx("size-3.5", !c.ok && "opacity-30")} /> {c.label}
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Setup key" description="Proves you're the person who deployed this app.">
          <Field label="Setup key" htmlFor="setup-key">
            <Input id="setup-key" type="password" autoComplete="off" spellCheck={false} value={form.setupKey} onChange={set("setupKey")} required className="font-mono" />
          </Field>
          <div className="mt-3">
            <SetupKeyHelp source={setupKeySource} />
          </div>
        </Panel>

        {error && <div className="rounded-ui bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</div>}
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={busy} disabled={!ready} icon={<KeyRound className="size-4" />}>
            Create account and continue
          </Button>
        </div>
      </form>
    </StepFrame>
  );
}
