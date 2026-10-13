import { useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Copy, RefreshCw, UserCheck, UserMinus, UserPlus, UserPen } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { useCanManage } from "@/lib/queries";
import { Badge, Button, Card, EmptyState, Field, LoadError, PageHeader, Section, Select, Spinner, Switch } from "@/components/ui/primitives";
import { Modal, useConfirm } from "@/components/ui/overlay";

interface ScimSettings {
  createMailbox: boolean;
  onboarding: "sso" | "invite";
}
interface ProvisioningInfo {
  baseUrl: string;
  token: { prefix: string; createdAt: string; lastUsedAt: string | null; createdBy: string | null } | null;
  settings: ScimSettings;
  lastSyncAt: string | null;
  linkedUsers: number;
  activity: { id: string; at: string; action: string; userId: string | null; email: string | null }[];
}

const ACTIONS: Record<string, { label: string; icon: typeof UserPlus }> = {
  "scim.user_created": { label: "Created", icon: UserPlus },
  "scim.user_updated": { label: "Updated", icon: UserPen },
  "scim.user_deactivated": { label: "Deactivated", icon: UserMinus },
  "scim.user_reactivated": { label: "Reactivated", icon: UserCheck },
};

function CopyField({ value }: { value: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-ui bg-subtle px-3 py-2.5 pr-11 font-mono text-xs break-all whitespace-pre-wrap">{value}</pre>
      <Button size="xs" variant="ghost" className="absolute top-1.5 right-1.5" aria-label="Copy" onClick={() => (navigator.clipboard.writeText(value), toast.success("Copied"))}>
        <Copy className="size-3.5" />
      </Button>
    </div>
  );
}

function Toggle({ title, description, checked, onChange, disabled }: { title: string; description: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div>
        <p className="text-[13px] font-medium">{title}</p>
        <p className="mt-0.5 text-xs text-fg-muted">{description}</p>
      </div>
      <Switch checked={checked} onChange={onChange} disabled={disabled} label={title} />
    </div>
  );
}

export function AdminProvisioning() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const editable = useCanManage();
  const [busy, setBusy] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["admin-provisioning"], queryFn: () => api.get<ProvisioningInfo>("admin/provisioning") });

  if (q.error && !q.data) return <LoadError error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Spinner />;
  const { baseUrl, token, settings, lastSyncAt, linkedUsers, activity } = q.data;
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin-provisioning"] });

  const rotate = async () => {
    if (token && !(await confirm({ title: "Replace the SCIM token?", body: "The current token stops working right away. Paste the new one into your identity provider.", confirmLabel: "Replace token", danger: true }))) return;
    setBusy(true);
    try {
      const res = await api.post<{ token: string }>("admin/provisioning/token");
      setNewToken(res.token);
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!(await confirm({ title: "Turn off provisioning?", body: "Your identity provider can no longer create, update or deactivate accounts until you issue a new token.", confirmLabel: "Revoke token", danger: true }))) return;
    try {
      await api.del("admin/provisioning/token");
      refresh();
      toast.success("Token revoked");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const save = async (next: ScimSettings) => {
    try {
      await api.put("admin/provisioning/settings", { ...next });
      refresh();
      toast.success("Saved");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Provisioning" description="Let Okta, Microsoft Entra ID or another identity provider create, update and deactivate accounts automatically (SCIM 2.0)." />

      <Section
        title="Connection"
        description="Paste these into your identity provider's provisioning settings."
        actions={
          editable && (
            <div className="flex gap-2">
              {token && (
                <Button size="sm" icon={<Ban className="size-4" />} onClick={revoke}>
                  Revoke
                </Button>
              )}
              <Button size="sm" variant="primary" loading={busy} icon={<RefreshCw className="size-4" />} onClick={rotate}>
                {token ? "Rotate token" : "Create token"}
              </Button>
            </div>
          )
        }
      >
        <div className="space-y-5">
          <Field label="SCIM base URL" hint="Okta: SCIM connector base URL. Entra ID: Tenant URL.">
            <CopyField value={baseUrl} />
          </Field>
          <Field label="Token">
            <p className="text-[13px]">
              {token ? (
                <>
                  <Badge tone="success">Active</Badge> <span className="font-mono">{token.prefix}…</span> · Created {relativeTime(token.createdAt)}
                  {token.createdBy && ` by ${token.createdBy}`} · {token.lastUsedAt ? `Last used ${relativeTime(token.lastUsedAt)}` : "Never used"}
                </>
              ) : (
                <span className="text-fg-muted">No token yet. Provisioning is off.</span>
              )}
            </p>
          </Field>
          <p className="text-xs text-fg-muted">
            {lastSyncAt ? `Last change from your identity provider ${relativeTime(lastSyncAt)}.` : "No changes from an identity provider yet."} {linkedUsers} {linkedUsers === 1 ? "account is" : "accounts are"} linked.
          </p>
        </div>
      </Section>

      <Section title="New accounts" description="What happens when your identity provider assigns someone to the app. Everyone provisioned is a member; roles are only changed here in Admin → Users.">
        <div className="space-y-5">
          <Toggle
            title="Create a personal mailbox"
            description="For people on one of your mail domains: gives them name@ your primary domain, unless that address is already in use."
            checked={settings.createMailbox}
            onChange={(v) => save({ ...settings, createMailbox: v })}
            disabled={!editable}
          />
          <Field label="How they get in" hint={settings.onboarding === "sso" ? "Their account is active right away; they sign in with Google. No email is sent." : "They get an email with a link to set a password, valid for 7 days."}>
            <Select value={settings.onboarding} disabled={!editable} onChange={(e) => save({ ...settings, onboarding: e.target.value as ScimSettings["onboarding"] })} className="w-64">
              <option value="sso">Active now, Google sign-in</option>
              <option value="invite">Send an invite email</option>
            </Select>
          </Field>
          <p className="text-xs text-fg-muted">Owners and admins can't be deactivated, reactivated or moved to another email through SCIM; manage them in Admin → Users. Deprovisioned people are deactivated, never deleted, so their mail stays.</p>
        </div>
      </Section>

      <Section title="Recent activity" description={<>Changes made by your identity provider. The full history is in the <Link to="/admin/logs/audit" className="text-accent-ink hover:underline">audit log</Link>.</>}>
        {!activity.length ? (
          <EmptyState icon={<UserPlus className="size-5" />} title="Nothing yet" body="Changes appear here once your identity provider starts syncing." />
        ) : (
          <Card className="divide-y divide-line">
            {activity.map((a) => {
              const meta = ACTIONS[a.action] ?? { label: a.action.replace(/^scim\./, ""), icon: UserPen };
              const Icon = meta.icon;
              return (
                <div key={a.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                  <Icon className="size-4 shrink-0 text-fg-muted" />
                  <span className="w-24 shrink-0 font-medium">{meta.label}</span>
                  <span className="min-w-0 flex-1 truncate">{a.email ?? a.userId}</span>
                  <span className="shrink-0 text-xs text-fg-muted">{relativeTime(a.at)}</span>
                </div>
              );
            })}
          </Card>
        )}
      </Section>

      {newToken && (
        <Modal
          open
          onClose={() => setNewToken(null)}
          width={620}
          title="Copy your SCIM token now"
          description="It won't be shown again. It can create and deactivate accounts, so store it like a password."
          footer={<Button variant="primary" onClick={() => setNewToken(null)}>Done</Button>}
        >
          <div className="space-y-5 text-[13px]">
            <Field label="Token" hint="Okta: API Token (HTTP Header auth). Entra ID: Secret Token.">
              <CopyField value={newToken} />
            </Field>
            <Field label="SCIM base URL">
              <CopyField value={baseUrl} />
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
