import { useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Copy, KeyRound, Plus } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { useCanManage } from "@/lib/queries";
import { Badge, Button, Card, Checkbox, EmptyState, Field, IconButton, Input, LoadError, PageHeader, Section, Spinner } from "@/components/ui/primitives";
import { Modal, useConfirm } from "@/components/ui/overlay";

interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  mailboxIds: string[];
  canActAs: boolean;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  createdBy: string | null;
}
interface MailboxLite {
  id: string;
  address: string;
  isActive: boolean;
}
const SCOPES = [
  { value: "send", label: "Send email", hint: "Send, schedule and draft from the chosen mailboxes" },
  { value: "contacts", label: "Contacts", hint: "Read and edit the address book and do-not-email list" },
  { value: "read", label: "Read mail", hint: "Read inboxes and conversations, to follow up on replies" },
];
const PRESETS = [
  { label: "MCP client (outreach)", name: "MCP client", scopes: ["send", "contacts", "read"], actAs: false },
  { label: "Send-only service", name: "Backend service", scopes: ["send"], actAs: false },
  { label: "Per-user integration", name: "Per-user integration", scopes: ["send", "read"], actAs: true },
];

/** Checkbox with visible text (the shared Checkbox only carries an aria-label). */
function CheckRow({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <Checkbox checked={checked} onChange={onChange} label={label} className="mt-0.5" />
      <span className="min-w-0">
        <span className="block text-[13px] text-fg">{label}</span>
        {hint && <span className="block text-xs text-fg-muted">{hint}</span>}
      </span>
    </label>
  );
}

function Code({ children }: { children: string }) {
  return (
    <div className="relative mt-1.5">
      <pre className="overflow-x-auto rounded-ui bg-subtle px-3 py-2.5 pr-11 font-mono text-xs break-all whitespace-pre-wrap">{children}</pre>
      <Button size="xs" variant="ghost" className="absolute top-1.5 right-1.5" aria-label="Copy" onClick={() => (navigator.clipboard.writeText(children), toast.success("Copied"))}>
        <Copy className="size-3.5" />
      </Button>
    </div>
  );
}

function CreatedKey({ created, onClose }: { created: { key: string; scopes: string[] }; onClose: () => void }) {
  const origin = window.location.origin;
  const forMcp = created.scopes.includes("contacts") || created.scopes.includes("read");
  return (
    <Modal open onClose={onClose} width={620} title="Copy your key now" description="It won't be shown again. Anyone with this key can use it, so store it like a password." footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <div className="space-y-5 text-[13px]">
        <Field label="API key">
          <Code>{created.key}</Code>
        </Field>
        {forMcp && (
          <div className="space-y-3">
            <p className="font-medium text-fg">Connect an MCP client</p>
            <Field label="Server URL" hint="Streamable HTTP transport.">
              <Code>{`${origin}/mcp`}</Code>
            </Field>
            <Field label="Header">
              <Code>{`Authorization: Bearer ${created.key}`}</Code>
            </Field>
            <Field label="Config file" hint="For clients configured with JSON. Clients that can't send headers can use the key-in-URL form instead.">
              <Code>{JSON.stringify({ mcpServers: { inboxos: { type: "http", url: `${origin}/mcp`, headers: { Authorization: `Bearer ${created.key}` } } } }, null, 2)}</Code>
            </Field>
            <Field label="Key-in-URL form">
              <Code>{`${origin}/mcp/${created.key}`}</Code>
            </Field>
          </div>
        )}
        {created.scopes.includes("send") && (
          <Field label="Another service (e.g. your backend)" hint="POST JSON to this URL with Authorization: Bearer <key>.">
            <Code>{`${origin}/api/v1/send`}</Code>
          </Field>
        )}
      </div>
    </Modal>
  );
}

function NewKeyDialog({ mailboxes, onClose, onCreated }: { mailboxes: MailboxLite[]; onClose: () => void; onCreated: (c: { key: string; scopes: string[] }) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(PRESETS[0].name);
  const [scopes, setScopes] = useState<string[]>(PRESETS[0].scopes);
  const [actAs, setActAs] = useState(PRESETS[0].actAs);
  const [limit, setLimit] = useState(false);
  const [boxes, setBoxes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const toggle = (list: string[], v: string, on: boolean) => (on ? [...list, v] : list.filter((x) => x !== v));
  const create = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ key: string }>("admin/api-keys", { name, scopes, mailboxIds: limit ? boxes : [], canActAs: actAs });
      qc.invalidateQueries({ queryKey: ["admin-api-keys"] });
      onCreated({ key: res.key, scopes });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="New API key"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim() || !scopes.length || (limit && !boxes.length)} onClick={create}>
            Create key
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <Button key={p.label} size="sm" variant={name === p.name && scopes.join() === p.scopes.join() ? "subtle" : "secondary"} onClick={() => (setName(p.name), setScopes(p.scopes), setActAs(p.actAs))}>
              {p.label}
            </Button>
          ))}
        </div>
        <Field label="Name" hint="Shown in the audit log next to everything this key does.">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Permissions">
          <div className="space-y-2.5">
            {SCOPES.map((s) => (
              <CheckRow key={s.value} checked={scopes.includes(s.value)} onChange={(on) => setScopes((x) => toggle(x, s.value, on))} label={s.label} hint={s.hint} />
            ))}
          </div>
        </Field>
        <Field label="On behalf of a user">
          <CheckRow
            checked={actAs}
            onChange={setActAs}
            label="Act as a user (X-Act-As)"
            hint="For an integration that works on behalf of your users. Each request may pass a user's email in X-Act-As, and the key is narrowed to the mailboxes that user belongs to."
          />
        </Field>
        <Field label="Mailboxes">
          <CheckRow checked={limit} onChange={setLimit} label="Only specific mailboxes" hint="Recommended for MCP clients and outreach tools. Otherwise the key can use every mailbox." />
          {limit && (
            <div className="mt-2.5 max-h-48 space-y-2 overflow-y-auto rounded-ui border border-line p-3">
              {mailboxes.filter((m) => m.isActive).map((m) => (
                <CheckRow key={m.id} checked={boxes.includes(m.id)} onChange={(on) => setBoxes((x) => toggle(x, m.id, on))} label={m.address} />
              ))}
            </div>
          )}
        </Field>
      </div>
    </Modal>
  );
}

export function AdminApiKeys() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const editable = useCanManage();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ key: string; scopes: string[] } | null>(null);
  const keys = useQuery({ queryKey: ["admin-api-keys"], queryFn: () => api.get<ApiKeyInfo[]>("admin/api-keys") });
  const { data: mailboxes = [] } = useQuery({ queryKey: ["admin-mailboxes"], queryFn: () => api.get<MailboxLite[]>("admin/mailboxes") });
  const boxName = (id: string) => mailboxes.find((m) => m.id === id)?.address ?? "removed mailbox";

  if (keys.error && !keys.data) return <LoadError error={keys.error} onRetry={() => keys.refetch()} />;
  if (!keys.data) return <Spinner />;

  const revoke = async (k: ApiKeyInfo) => {
    if (!(await confirm({ title: `Revoke "${k.name}"?`, body: "Anything using this key stops working immediately.", confirmLabel: "Revoke", danger: true }))) return;
    try {
      await api.del(`admin/api-keys/${k.id}`);
      qc.invalidateQueries({ queryKey: ["admin-api-keys"] });
      toast.success("Key revoked");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="API & MCP"
        description="Keys that let other services and MCP clients manage contacts and send email from your mailboxes."
        actions={editable && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New key</Button>}
      />

      <Card className="divide-y divide-line">
        {!keys.data.length && <EmptyState icon={<KeyRound className="size-5" />} title="No API keys yet" body="Create one to connect another service or an MCP client." />}
        {keys.data.map((k) => (
          <div key={k.id} className="flex items-center gap-3 px-5 py-3">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-[13px] font-medium">
                {k.name}
                {k.revokedAt ? <Badge tone="danger">Revoked</Badge> : <>{k.scopes.map((s) => <Badge key={s}>{s}</Badge>)}{k.canActAs && <Badge tone="accent">act-as</Badge>}</>}
              </p>
              <p className="truncate text-xs text-fg-muted">
                <span className="font-mono">{k.prefix}…</span> · {k.mailboxIds.length ? k.mailboxIds.map(boxName).join(", ") : "All mailboxes"} ·{" "}
                {k.lastUsedAt ? `Used ${relativeTime(k.lastUsedAt)}` : "Never used"} · Created {relativeTime(k.createdAt)}
                {k.createdBy && ` by ${k.createdBy}`}
              </p>
            </div>
            {editable && !k.revokedAt && (
              <IconButton label="Revoke" onClick={() => revoke(k)}>
                <Ban className="size-4" />
              </IconButton>
            )}
          </div>
        ))}
      </Card>

      <Section title="Do-not-email list" description="People who unsubscribed, hard-bounced or marked you as spam. API sends to them are refused.">
        <Link to="/admin/unsubscribes" className="text-[13px] font-medium text-accent hover:underline">
          See everyone on the list →
        </Link>
      </Section>

      {creating && <NewKeyDialog mailboxes={mailboxes} onClose={() => setCreating(false)} onCreated={(c) => (setCreating(false), setCreated(c))} />}
      {created && <CreatedKey created={created} onClose={() => setCreated(null)} />}
    </div>
  );
}
