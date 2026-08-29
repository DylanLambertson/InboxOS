import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, CircleDashed, Copy } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useBrand } from "@/lib/brand";
import { Badge, Button, PageHeader, Section, cx } from "@/components/ui/primitives";
import type { OverviewData } from "./Overview";

function Code({ children }: { children: string }) {
  return (
    <div className="group relative mt-2">
      <pre className="overflow-x-auto rounded-ui bg-subtle px-3 py-2.5 pr-12 font-mono text-xs">{children}</pre>
      <Button
        size="xs"
        variant="ghost"
        className="absolute top-1.5 right-1.5"
        onClick={() => (navigator.clipboard.writeText(children), toast.success("Copied"))}
        aria-label="Copy"
      >
        <Copy className="size-3.5" />
      </Button>
    </div>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: ReactNode }) {
  return (
    <div className="flex gap-4">
      <div className="flex flex-col items-center">
        <span className={cx("flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold", done ? "bg-success-soft text-success" : "bg-muted text-fg-muted")}>
          {done ? <CheckCircle2 className="size-4" /> : n}
        </span>
        <span className="mt-2 w-px flex-1 bg-line" />
      </div>
      <div className="min-w-0 flex-1 pb-8">
        <h3 className="text-[14px] font-semibold">{title}</h3>
        <div className="mt-1 space-y-2 text-[13px] text-fg-muted">{children}</div>
      </div>
    </div>
  );
}

export function AdminSetup() {
  const brand = useBrand();
  const { data } = useQuery({ queryKey: ["admin-overview"], queryFn: () => api.get<OverviewData>("admin/overview") });
  const { data: domains } = useQuery({
    queryKey: ["admin-domains"],
    queryFn: () => api.get<{ name: string; status: string; region: string }[] | { error: string }>("admin/domains"),
  });
  const p = data?.provider;
  const origin = window.location.origin;

  return (
    <div className="space-y-6">
      <PageHeader title="Setup guide" description="Connect your email provider. Takes about ten minutes." />

      {domains && Array.isArray(domains) && domains.length > 0 && (
        <Section title="Domains in Resend">
          <ul className="divide-y divide-line">
            {domains.map((d) => (
              <li key={d.name} className="flex items-center justify-between py-2 text-[13px] first:pt-0 last:pb-0">
                <span className="font-medium">{d.name}</span>
                <Badge tone={d.status === "verified" ? "success" : "warning"}>
                  {d.status === "verified" ? <CheckCircle2 className="size-3" /> : <CircleDashed className="size-3" />}
                  {d.status}
                </Badge>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Steps">
        <Step n={1} title="Verify your domain for sending">
          <p>
            In Resend → <b>Domains</b>, add <code className="text-fg">{brand.primaryDomain}</code> and create the DKIM/SPF DNS records it shows. Wait until it says <b>Verified</b>.
          </p>
        </Step>
        <Step n={2} title="Turn on receiving">
          <p>
            In the domain's settings in Resend, enable <b>Receiving</b> and add the MX record it gives you at your DNS provider. Mail sent to any address at the domain then flows into this app.
          </p>
          <p className="text-xs">If other mail already uses this domain (e.g. Google Workspace), use a subdomain such as <code className="text-fg">mail.{brand.primaryDomain}</code> for receiving instead.</p>
        </Step>
        <Step n={3} title="Create an API key" done={p?.apiKey}>
          <p>Resend → <b>API Keys</b> → create a key with <b>Full access</b> (it must be able to read received mail). Then store it as a Worker secret:</p>
          <Code>npx wrangler secret put RESEND_API_KEY</Code>
        </Step>
        <Step n={4} title="Add the webhook" done={p?.webhookSecret}>
          <p>Resend → <b>Webhooks</b> → add this endpoint and select <b>all email events</b> (including <code className="text-fg">email.received</code>):</p>
          <Code>{p?.webhookUrl ?? `${origin}/webhooks/resend`}</Code>
          <p>Copy the webhook's signing secret (starts with <code className="text-fg">whsec_</code>) and store it:</p>
          <Code>npx wrangler secret put RESEND_WEBHOOK_SECRET</Code>
        </Step>
        <Step n={5} title="Create mailboxes and invite your team">
          <p>Go to <b>Users</b> to invite people (each can get a personal mailbox), and <b>Mailboxes</b> to create shared inboxes like support@ or hello@.</p>
        </Step>
        <Step n={6} title="Optional: Google sign-in" done={p?.google}>
          <p>
            In Google Cloud Console → <b>APIs & Services → Credentials</b>, create an <b>OAuth client ID</b> (Web application) with this authorized redirect URI:
          </p>
          <Code>{`${origin}/api/auth/google/callback`}</Code>
          <Code>{"npx wrangler secret put GOOGLE_CLIENT_ID\nnpx wrangler secret put GOOGLE_CLIENT_SECRET"}</Code>
          <p>Then choose allowed domains in <b>Settings & policy</b>.</p>
        </Step>
        <Step n={7} title="When you upgrade your Resend plan">
          <p>Raise the daily and monthly limits in <b>Settings & policy</b>. No code changes are needed.</p>
        </Step>
      </Section>
    </div>
  );
}
