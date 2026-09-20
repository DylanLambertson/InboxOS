import { useState } from "react";
import { Link, useParams } from "react-router";
import { MailCheck } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { Button } from "@/components/ui/primitives";
import { AuthLayout } from "./Auth";

/**
 * Confirms a personal address from the emailed link. It only confirms on the
 * button press: mail scanners open links on their own and would use it up.
 */
export function VerifyEmailPage() {
  const { token = "" } = useParams();
  const [state, setState] = useState<"ask" | "busy" | "done">("ask");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setState("busy");
    setError(null);
    try {
      const r = await api.post<{ email: string }>("/api/digest/verify-email", { token });
      setEmail(r.email);
      setState("done");
    } catch (e) {
      setError(errorMessage(e));
      setState("ask");
    }
  };

  return (
    <AuthLayout title={state === "done" ? "Email confirmed" : "Confirm your email"} subtitle={state === "done" ? undefined : "This lets us send unread-mail reminders to this address."}>
      {state === "done" ? (
        <div className="text-center">
          <MailCheck className="mx-auto mb-3 size-9 text-success" />
          <p className="text-[13px] text-fg-muted">
            <b className="text-fg">{email}</b> is confirmed. Turn on reminders and choose how often in Settings → Profile.
          </p>
          <Link to="/settings/profile" className="mt-5 inline-block">
            <Button variant="primary">Open settings</Button>
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {error && <p className="rounded-ui bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p>}
          <Button variant="primary" className="w-full" loading={state === "busy"} onClick={confirm}>
            Confirm this email
          </Button>
          <p className="text-center text-xs text-fg-muted">Didn't ask for this? Close this page and nothing will be sent.</p>
        </div>
      )}
    </AuthLayout>
  );
}
