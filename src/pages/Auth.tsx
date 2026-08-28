import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, KeyRound } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { useBrand } from "@/lib/brand";
import { Logo } from "@/components/layout/Logo";
import { Button, Field, Input, Spinner } from "@/components/ui/primitives";

const OAUTH_ERRORS: Record<string, string> = {
  google_disabled: "Google sign-in isn't enabled.",
  google_state: "Your sign-in session expired. Please try again.",
  google_exchange: "Google sign-in failed. Please try again.",
  google_token: "Google couldn't verify your account.",
  google_no_account: "There's no account for that Google user. Ask an administrator to invite you.",
  google_domain: "That Google account's domain isn't allowed.",
  google_mismatch: "This account is linked to a different Google user.",
  account_disabled: "Your account has been disabled. Contact an administrator.",
};

function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  const brand = useBrand();
  return (
    <div className="flex min-h-full flex-col bg-subtle">
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="animate-in w-full max-w-[380px]">
          <div className="mb-8 flex justify-center">
            <Logo size={40} withName={false} />
          </div>
          <div className="mb-6 text-center">
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            {subtitle && <p className="mt-1.5 text-[13px] text-fg-muted">{subtitle}</p>}
          </div>
          <div className="rounded-ui-lg border border-line bg-surface p-6 shadow-ui-md">{children}</div>
          {brand.supportEmail && (
            <p className="mt-6 text-center text-xs text-fg-muted">
              Need help? <a className="text-fg underline-offset-2 hover:underline" href={`mailto:${brand.supportEmail}`}>{brand.supportEmail}</a>
            </p>
          )}
        </div>
      </div>
      <p className="pb-6 text-center text-xs text-fg-faint">{brand.footerText}</p>
    </div>
  );
}

function ErrorNote({ children }: { children: ReactNode }) {
  return <div className="mb-4 rounded-ui bg-danger-soft px-3 py-2 text-[13px] text-danger">{children}</div>;
}

function GoogleButton({ next }: { next: string }) {
  return (
    <a
      href={`/api/auth/google/start?next=${encodeURIComponent(next)}`}
      className="flex h-9 w-full items-center justify-center gap-2 rounded-ui border border-line bg-surface text-sm font-medium shadow-ui-sm transition-colors hover:bg-subtle"
    >
      <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
        <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.07H2.18a11 11 0 0 0 0 9.86l3.66-2.84z" />
        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A10.96 10.96 0 0 0 12 1 11 11 0 0 0 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" />
      </svg>
      Continue with Google
    </a>
  );
}

export function LoginPage() {
  const brand = useBrand();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const next = params.get("next") || "/";
  const [step, setStep] = useState<"password" | "2fa" | "forgot" | "forgot-sent">(params.get("step") === "2fa" ? "2fa" : "password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(OAUTH_ERRORS[params.get("error") ?? ""] ?? null);
  const { data: options } = useQuery({ queryKey: ["auth-options"], queryFn: () => api.get<{ password: boolean; google: boolean }>("/api/auth/options") });
  const { data: state } = useQuery({ queryKey: ["auth-state"], queryFn: () => api.get<{ signedIn: boolean; mfaPending: boolean }>("/api/auth/state") });

  useEffect(() => {
    if (state?.signedIn) navigate(next, { replace: true });
    if (state?.mfaPending) setStep("2fa");
  }, [state, next, navigate]);

  const done = async () => {
    await qc.invalidateQueries();
    navigate(next, { replace: true });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (step === "password") {
        const r = await api.post<{ ok?: boolean; mfaRequired?: boolean }>("/api/auth/login", { email, password });
        if (r.mfaRequired) setStep("2fa");
        else await done();
      } else if (step === "2fa") {
        await api.post("/api/auth/2fa", { code });
        await done();
      } else if (step === "forgot") {
        await api.post("/api/auth/forgot", { email });
        setStep("forgot-sent");
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (step === "2fa") {
    return (
      <AuthLayout title="Two-factor authentication" subtitle="Enter the 6-digit code from your authenticator app, or a recovery code.">
        {error && <ErrorNote>{error}</ErrorNote>}
        <form onSubmit={submit} className="space-y-4">
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123 456"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            className="h-11 text-center font-mono text-lg tracking-[0.3em]"
          />
          <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={code.replace(/\s/g, "").length < 6}>
            Verify
          </Button>
        </form>
        <button onClick={() => (setStep("password"), setError(null))} className="mt-4 flex w-full items-center justify-center gap-1 text-xs text-fg-muted hover:text-fg">
          <ArrowLeft className="size-3" /> Use a different account
        </button>
      </AuthLayout>
    );
  }

  if (step === "forgot" || step === "forgot-sent") {
    return (
      <AuthLayout title="Reset your password" subtitle={step === "forgot" ? "We'll email you a link to choose a new password." : undefined}>
        {step === "forgot-sent" ? (
          <div className="text-center">
            <CheckCircle2 className="mx-auto mb-3 size-8 text-success" />
            <p className="text-[13px] text-fg-muted">If an account exists for <span className="font-medium text-fg">{email}</span>, a reset link is on its way.</p>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            {error && <ErrorNote>{error}</ErrorNote>}
            <Field label="Email">
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus required />
            </Field>
            <Button type="submit" variant="primary" className="w-full" loading={busy}>
              Send reset link
            </Button>
          </form>
        )}
        <button onClick={() => (setStep("password"), setError(null))} className="mt-4 flex w-full items-center justify-center gap-1 text-xs text-fg-muted hover:text-fg">
          <ArrowLeft className="size-3" /> Back to sign in
        </button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={brand.loginHeadline} subtitle={brand.loginTagline}>
      {error && <ErrorNote>{error}</ErrorNote>}
      {options?.google && (
        <>
          <GoogleButton next={next} />
          {options.password && (
            <div className="my-5 flex items-center gap-3 text-xs text-fg-faint">
              <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
            </div>
          )}
        </>
      )}
      {(options?.password ?? true) && (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Email" htmlFor="email">
            <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" autoFocus required />
          </Field>
          <Field
            label={
              <span className="flex items-center justify-between">
                Password
                <button type="button" onClick={() => (setStep("forgot"), setError(null))} className="text-xs font-normal text-fg-muted hover:text-fg">
                  Forgot?
                </button>
              </span>
            }
            htmlFor="password"
          >
            <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          </Field>
          <Button type="submit" variant="primary" className="w-full" loading={busy}>
            Sign in
          </Button>
        </form>
      )}
      {options && !options.password && !options.google && <p className="text-center text-[13px] text-fg-muted">Sign-in is currently disabled.</p>}
    </AuthLayout>
  );
}

function PasswordForm({ submitLabel, onSubmit, withName, initialName = "" }: { submitLabel: string; onSubmit: (d: { name: string; password: string }) => Promise<void>; withName?: boolean; initialName?: string }) {
  const [name, setName] = useState(initialName);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mismatch = confirm.length > 0 && confirm !== password;
  const checks = [
    { ok: password.length >= 10, label: "10+ characters" },
    { ok: [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length >= 3, label: "3 of: lower, upper, number, symbol" },
  ];
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await onSubmit({ name, password });
        } catch (err) {
          setError(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {error && <ErrorNote>{error}</ErrorNote>}
      {withName && (
        <Field label="Your name">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required autoFocus={!initialName} />
        </Field>
      )}
      <Field label="Password">
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required autoFocus={!withName || !!initialName} />
      </Field>
      <ul className="-mt-2 space-y-0.5">
        {checks.map((c) => (
          <li key={c.label} className={`flex items-center gap-1.5 text-xs ${c.ok ? "text-success" : "text-fg-muted"}`}>
            <CheckCircle2 className="size-3" /> {c.label}
          </li>
        ))}
      </ul>
      <Field label="Confirm password" error={mismatch ? "Passwords don't match" : null}>
        <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
      </Field>
      <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={!checks.every((c) => c.ok) || mismatch || !confirm}>
        {submitLabel}
      </Button>
    </form>
  );
}

export function InvitePage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({
    queryKey: ["invite", token],
    queryFn: () => api.get<{ email: string; name: string; company: string }>(`/api/auth/invite/${token}`),
    retry: false,
  });
  const { data: options } = useQuery({ queryKey: ["auth-options"], queryFn: () => api.get<{ password: boolean; google: boolean }>("/api/auth/options") });

  if (isLoading) return <AuthLayout title="Loading invite…"><div className="flex justify-center"><Spinner /></div></AuthLayout>;
  if (error || !data) {
    return (
      <AuthLayout title="Invite unavailable">
        <p className="text-center text-[13px] text-fg-muted">{errorMessage(error)}</p>
        <Link to="/login" className="mt-4 block text-center text-xs text-fg-muted hover:text-fg">Go to sign in</Link>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title={`Join ${data.company}`} subtitle={<>Set up your account for <span className="font-medium text-fg">{data.email}</span></>}>
      {options?.google && (
        <>
          <GoogleButton next="/" />
          <div className="my-5 flex items-center gap-3 text-xs text-fg-faint">
            <span className="h-px flex-1 bg-line" /> or set a password <span className="h-px flex-1 bg-line" />
          </div>
        </>
      )}
      <PasswordForm
        withName
        initialName={data.name}
        submitLabel="Create account"
        onSubmit={async ({ name, password }) => {
          await api.post("/api/auth/invite/accept", { token, name, password });
          await qc.invalidateQueries();
          navigate("/", { replace: true });
        }}
      />
    </AuthLayout>
  );
}

export function ResetPage() {
  const { token = "" } = useParams();
  const [done, setDone] = useState(false);
  return (
    <AuthLayout title="Choose a new password" subtitle={done ? undefined : "You'll be signed out of all other devices."}>
      {done ? (
        <div className="text-center">
          <KeyRound className="mx-auto mb-3 size-8 text-success" />
          <p className="text-[13px] text-fg-muted">Your password has been updated.</p>
          <Link to="/login" className="mt-4 inline-block">
            <Button variant="primary">Sign in</Button>
          </Link>
        </div>
      ) : (
        <PasswordForm
          submitLabel="Update password"
          onSubmit={async ({ password }) => {
            await api.post("/api/auth/reset", { token, password });
            setDone(true);
          }}
        />
      )}
    </AuthLayout>
  );
}
