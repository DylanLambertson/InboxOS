import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Brand, OrgPolicy } from "@shared/brand";
import { api, errorMessage } from "@/lib/api";
import { useMe } from "@/lib/queries";
import { Button, Field, Input, LoadError, PageHeader, Section, Select, Spinner, Switch } from "@/components/ui/primitives";

function Toggle({ title, description, checked, onChange, disabled }: { title: string; description?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-6 py-3 first:pt-0 last:pb-0">
      <div>
        <p className="text-[13px] font-medium">{title}</p>
        {description && <p className="mt-0.5 text-xs text-fg-muted">{description}</p>}
      </div>
      <Switch checked={checked} onChange={onChange} disabled={disabled} label={title} />
    </div>
  );
}

function NumberField({ label, hint, value, onChange, min = 0, suffix }: { label: string; hint?: string; value: number; onChange: (n: number) => void; min?: number; suffix?: string }) {
  return (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <Input type="number" min={min} value={value} onChange={(e) => onChange(Math.max(min, parseInt(e.target.value || "0", 10)))} className="w-32" />
        {suffix && <span className="text-[13px] text-fg-muted">{suffix}</span>}
      </div>
    </Field>
  );
}

export function AdminPolicy() {
  const { data, error, refetch } = useQuery({ queryKey: ["admin-settings"], queryFn: () => api.get<{ brand: Brand; policy: OrgPolicy }>("admin/settings") });
  const { data: me } = useMe();
  const qc = useQueryClient();
  const [p, setP] = useState<OrgPolicy | null>(null);
  const [domains, setDomains] = useState("");
  const [busy, setBusy] = useState(false);
  const isOwner = me?.role === "owner";

  useEffect(() => {
    if (data) {
      setP(data.policy);
      setDomains(data.policy.googleAllowedDomains.join(", "));
    }
  }, [data]);
  if (error && !data) return <LoadError error={error} onRetry={() => refetch()} />;
  if (!p || !data) return <Spinner />;
  const set = <K extends keyof OrgPolicy>(k: K, v: OrgPolicy[K]) => setP((x) => (x ? { ...x, [k]: v } : x));

  const save = async () => {
    setBusy(true);
    const next: Partial<OrgPolicy> = { ...p, googleAllowedDomains: domains.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean) };
    if (!isOwner) {
      for (const k of ["require2fa", "passwordLoginEnabled", "googleSsoEnabled", "googleAllowedDomains", "googleAutoProvision", "sessionDays"] as const) delete next[k];
    }
    delete next.catchAllMailboxId;
    // Edited in Admin → Security; don't overwrite it with a stale copy.
    delete next.ipAllowlist;
    delete next.ipAllowlistEnforceFor;
    try {
      await api.put("admin/settings/policy", next as Record<string, unknown>);
      qc.invalidateQueries({ queryKey: ["admin-settings"] });
      qc.invalidateQueries({ queryKey: ["admin-overview"] });
      qc.invalidateQueries({ queryKey: ["me"] });
      toast.success("Settings saved");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings & policy"
        description="Organization-wide limits, retention and security."
        actions={<Button variant="primary" loading={busy} onClick={save}>Save changes</Button>}
      />

      <Section title="Sending limits" description="Match these to your email provider's plan. Resend's free plan allows 100 emails/day and 3,000/month. Set 0 for no limit.">
        <div className="grid gap-5 sm:grid-cols-3">
          <NumberField label="Daily limit" value={p.dailySendLimit} onChange={(n) => set("dailySendLimit", n)} suffix="emails / day" />
          <NumberField label="Monthly limit" value={p.monthlySendLimit} onChange={(n) => set("monthlySendLimit", n)} suffix="emails / month" />
          <NumberField label="Max attachments" value={p.maxAttachmentMb} min={1} onChange={(n) => set("maxAttachmentMb", Math.min(40, n))} suffix="MB per message" />
        </div>
        <div className="mt-5 border-t border-line pt-4">
          <Toggle
            title="Open & click tracking"
            description="Show opens and clicks on sent mail. Also turn on tracking for your domain in Resend."
            checked={p.trackingEnabled}
            onChange={(v) => set("trackingEnabled", v)}
          />
          <Field
            className="mt-4"
            label="Unread-mail reminders to personal email"
            hint="People can get an email every few hours at a personal address listing unread mail. Choose what it may show, or turn it off."
          >
            <Select value={p.digestDetail} onChange={(e) => set("digestDetail", e.target.value as OrgPolicy["digestDetail"])} className="w-auto">
              <option value="subjects">Senders and subjects</option>
              <option value="count">Only how many unread</option>
              <option value="off">Off: don't allow reminders</option>
            </Select>
          </Field>
        </div>
      </Section>

      <Section title="Data retention">
        <div className="grid gap-5 sm:grid-cols-2">
          <NumberField label="Empty Trash & Spam after" value={p.trashRetentionDays} min={1} onChange={(n) => set("trashRetentionDays", n)} suffix="days" />
          <NumberField label="Keep delivery & audit logs for" hint="0 keeps them forever." value={p.logRetentionDays} onChange={(n) => set("logRetentionDays", n)} suffix="days" />
        </div>
      </Section>

      <Section title="Security" description={isOwner ? undefined : "Only owners can change security settings."}>
        <div className="divide-y divide-line">
          <Toggle title="Require two-factor authentication" description="Everyone must add a passkey or set up an authenticator app before using the app." checked={p.require2fa} onChange={(v) => set("require2fa", v)} disabled={!isOwner} />
          <Toggle title="Allow password sign-in" description="Turn off to require Google sign-in. Owners can always use their password as a break-glass." checked={p.passwordLoginEnabled} onChange={(v) => set("passwordLoginEnabled", v)} disabled={!isOwner} />
          <div className="py-3">
            <NumberField label="Session length" hint="How long people stay signed in without activity." value={p.sessionDays} min={1} onChange={(n) => set("sessionDays", Math.min(90, n))} suffix="days" />
          </div>
        </div>
      </Section>

      <Section title="Google sign-in" description="Requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET — see the setup guide.">
        <div className="divide-y divide-line">
          <Toggle title="Enable Google sign-in" checked={p.googleSsoEnabled} onChange={(v) => set("googleSsoEnabled", v)} disabled={!isOwner} />
          <div className="py-3">
            <Field label="Allowed Google Workspace domains" hint="Comma-separated. Leave empty to allow any Google account that has been invited.">
              <Input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder={data.brand.primaryDomain} disabled={!isOwner} />
            </Field>
          </div>
          <Toggle
            title="Create accounts automatically"
            description="Anyone with a Google account on an allowed domain can sign in and gets a member account (plus a personal mailbox on your primary domain)."
            checked={p.googleAutoProvision}
            onChange={(v) => set("googleAutoProvision", v)}
            disabled={!isOwner}
          />
        </div>
      </Section>
    </div>
  );
}
