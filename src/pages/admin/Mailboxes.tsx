import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AtSign, ChevronRight, Inbox, Plus, Trash2, Users, X } from "lucide-react";
import { toast } from "sonner";
import type { MailboxRole } from "@shared/types";
import { api, errorMessage } from "@/lib/api";
import { useBrand } from "@/lib/brand";
import { fileSize, mailboxLabel, relativeTime } from "@/lib/format";
import { useCanManage, useMe } from "@/lib/queries";
import { LABEL_COLORS } from "@/components/mail/LabelDialog";
import { Avatar, Badge, Button, Card, cx, EmptyState, Field, IconButton, Input, LoadError, PageHeader, Select, Spinner, Switch } from "@/components/ui/primitives";
import { Modal, useConfirm } from "@/components/ui/overlay";

interface AdminMailbox {
  id: string;
  address: string;
  name: string;
  displayName: string;
  type: "personal" | "shared";
  color: string;
  isActive: boolean;
  isCatchAll: boolean;
  createdAt: string;
  messageCount: number;
  storageBytes: number;
  lastActivity: string | null;
  aliases: string[];
  members: { userId: string; name: string; email: string; avatarColor: string; role: MailboxRole }[];
}

interface UserLite {
  id: string;
  name: string;
  email: string;
  status: string;
}

const ROLE_LABEL: Record<MailboxRole, string> = { owner: "Owner", editor: "Can send", viewer: "Read only" };

function CreateDialog({ onClose }: { onClose: () => void }) {
  const brand = useBrand();
  const qc = useQueryClient();
  const [local, setLocal] = useState("");
  const [domain, setDomain] = useState(brand.primaryDomain);
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [type, setType] = useState<"shared" | "personal">("shared");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api.post("admin/mailboxes", { address: `${local.trim()}@${domain.trim()}`, name, displayName, type });
      qc.invalidateQueries({ queryKey: ["admin-mailboxes"] });
      toast.success("Mailbox created — add members next");
      onClose();
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
      title="New mailbox"
      description="Shared mailboxes (like hello@ or support@) can have many members. Mail is only received for domains set up in your email provider."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!local.trim()} onClick={submit}>
            Create mailbox
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Address">
          <div className="flex items-center gap-1.5">
            <Input value={local} onChange={(e) => setLocal(e.target.value.replace(/[@\s]/g, ""))} placeholder="support" autoFocus />
            <span className="text-fg-muted">@</span>
            <Input value={domain} onChange={(e) => setDomain(e.target.value.trim())} />
          </div>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Mailbox name" hint="Label in everyone's sidebar. Only your team sees it.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={local ? local.charAt(0).toUpperCase() + local.slice(1) : "Support"} />
          </Field>
          <Field label="Sender name" hint="What recipients see in the From line.">
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={`${brand.companyName} Support`} />
          </Field>
        </div>
        <Field label="Type">
          <Select value={type} onChange={(e) => setType(e.target.value as "shared" | "personal")}>
            <option value="shared">Shared — a team inbox</option>
            <option value="personal">Personal — one person's inbox</option>
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

function MailboxDetail({ box, onClose, readOnly }: { box: AdminMailbox; onClose: () => void; readOnly: boolean }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: me } = useMe();
  const { data: users = [] } = useQuery({ queryKey: ["admin-users"], queryFn: () => api.get<UserLite[]>("admin/users") });
  const [label, setLabel] = useState(box.name);
  const [displayName, setDisplayName] = useState(box.displayName);
  const [alias, setAlias] = useState("");
  const [addUser, setAddUser] = useState("");
  const [addRole, setAddRole] = useState<MailboxRole>("editor");
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["admin-mailboxes"] });
    qc.invalidateQueries({ queryKey: ["mailboxes"] });
  };
  const run = async (fn: () => Promise<unknown>, msg?: string) => {
    try {
      await fn();
      if (msg) toast.success(msg);
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const nonMembers = users.filter((u) => u.status !== "disabled" && !box.members.some((m) => m.userId === u.id));

  const destroy = async () => {
    const ok = await confirm({
      title: `Delete ${box.address}?`,
      body: `All ${box.messageCount.toLocaleString()} messages and attachments will be permanently deleted. This can't be undone.`,
      confirmLabel: "Delete mailbox",
      danger: true,
      typeToConfirm: box.address,
    });
    if (!ok) return;
    const t = toast.loading("Deleting mailbox…");
    try {
      for (let i = 0; i < 200; i++) {
        const r = await api.del<{ remaining: boolean }>(`admin/mailboxes/${box.id}`, { confirm: box.address });
        if (!r.remaining) break;
      }
      toast.success("Mailbox deleted", { id: t });
      refresh();
      onClose();
    } catch (e) {
      toast.error(errorMessage(e), { id: t });
    }
  };

  return (
    <Modal open onClose={onClose} title={mailboxLabel(box)} description={`${box.address} · ${box.messageCount.toLocaleString()} messages · ${fileSize(box.storageBytes)}${readOnly ? " · view only" : ""}`} width={640}>
      <fieldset disabled={readOnly} className="min-w-0 space-y-6">
        <section className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Mailbox name" hint="Sidebar label (team only).">
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={box.address.split("@")[0]} />
            </Field>
            <Field label="Sender name" hint="Recipients see this in the From line.">
              <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </Field>
          </div>
          {!readOnly && (label !== box.name || displayName !== box.displayName) && (
            <div className="-mt-1 flex justify-end">
              <Button size="sm" variant="primary" onClick={() => run(() => api.patch(`admin/mailboxes/${box.id}`, { name: label, displayName }), "Saved")}>
                Save names
              </Button>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
            <Field label="Type">
              <Select value={box.type} onChange={(e) => run(() => api.patch(`admin/mailboxes/${box.id}`, { type: e.target.value }))}>
                <option value="shared">Shared</option>
                <option value="personal">Personal</option>
              </Select>
            </Field>
          </div>
          <Field label="Color">
            <div className="flex flex-wrap gap-2">
              {LABEL_COLORS.map((c) => (
                <button
                  key={c}
                  aria-label={c}
                  onClick={() => run(() => api.patch(`admin/mailboxes/${box.id}`, { color: c }))}
                  className={cx("size-6 rounded-full ring-offset-2 ring-offset-raised", box.color === c && "ring-2 ring-fg")}
                  style={{ background: c }}
                />
              ))}
            </div>
          </Field>
          <div className="divide-y divide-line rounded-ui border border-line">
            <label className="flex items-center justify-between gap-4 px-3 py-2.5">
              <span>
                <span className="block text-[13px] font-medium">Active</span>
                <span className="text-xs text-fg-muted">Inactive mailboxes stop receiving and sending mail.</span>
              </span>
              <Switch checked={box.isActive} onChange={(v) => run(() => api.patch(`admin/mailboxes/${box.id}`, { isActive: v }))} label="Active" />
            </label>
            <label className="flex items-center justify-between gap-4 px-3 py-2.5">
              <span>
                <span className="block text-[13px] font-medium">Catch-all</span>
                <span className="text-xs text-fg-muted">Receive mail sent to any unknown address at your domains.</span>
              </span>
              <Switch checked={box.isCatchAll} onChange={(v) => run(() => api.patch(`admin/mailboxes/${box.id}`, { isCatchAll: v }), v ? "Set as catch-all" : "Catch-all removed")} label="Catch-all" />
            </label>
          </div>
        </section>

        <section>
          <h3 className="mb-2 flex items-center gap-2 text-[13px] font-semibold"><Users className="size-4" /> Members</h3>
          <div className="divide-y divide-line rounded-ui border border-line">
            {box.members.length === 0 && <p className="px-3 py-3 text-xs text-fg-muted">No one can access this mailbox yet.</p>}
            {box.members.map((m) => (
              <div key={m.userId} className="flex items-center gap-3 px-3 py-2">
                <Avatar name={m.name} email={m.email} color={m.avatarColor} size={26} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">{m.name || m.email} {m.userId === me?.id && <span className="text-xs font-normal text-fg-muted">(you)</span>}</p>
                  <p className="truncate text-xs text-fg-muted">{m.email}</p>
                </div>
                <Select value={m.role} onChange={(e) => run(() => api.put(`admin/mailboxes/${box.id}/members/${m.userId}`, { role: e.target.value }), "Access updated")} className="h-8 w-32 text-[13px]">
                  {Object.entries(ROLE_LABEL).map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </Select>
                <IconButton size="sm" label="Remove" onClick={() => run(() => api.del(`admin/mailboxes/${box.id}/members/${m.userId}`), "Member removed")}>
                  <X className="size-4" />
                </IconButton>
              </div>
            ))}
          </div>
          {!readOnly && nonMembers.length > 0 && (
            <div className="mt-2 flex gap-2">
              <Select value={addUser} onChange={(e) => setAddUser(e.target.value)} className="flex-1">
                <option value="">Add a person…</option>
                {nonMembers.map((u) => (
                  <option key={u.id} value={u.id}>{u.name ? `${u.name} (${u.email})` : u.email}</option>
                ))}
              </Select>
              <Select value={addRole} onChange={(e) => setAddRole(e.target.value as MailboxRole)} className="w-32">
                {Object.entries(ROLE_LABEL).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </Select>
              <Button
                disabled={!addUser}
                onClick={() => run(async () => {
                  await api.put(`admin/mailboxes/${box.id}/members/${addUser}`, { role: addRole });
                  setAddUser("");
                }, "Member added")}
              >
                Add
              </Button>
            </div>
          )}
          <p className="mt-2 text-xs text-fg-muted">Admins don't automatically see mailbox contents — adding yourself is recorded in the audit log.</p>
        </section>

        <section>
          <h3 className="mb-2 flex items-center gap-2 text-[13px] font-semibold"><AtSign className="size-4" /> Aliases</h3>
          <p className="mb-2 text-xs text-fg-muted">Extra addresses that deliver into this mailbox. Members can also send as them.</p>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {box.aliases.map((a) => (
              <span key={a} className="inline-flex items-center gap-1 rounded-full bg-muted py-0.5 pr-1 pl-2.5 text-xs">
                {a}
                <button aria-label={`Remove ${a}`} onClick={() => run(() => api.del(`admin/mailboxes/${box.id}/aliases/${encodeURIComponent(a)}`), "Alias removed")} className="rounded-full p-0.5 hover:bg-line">
                  <X className="size-3" />
                </button>
              </span>
            ))}
            {!box.aliases.length && <span className="text-xs text-fg-faint">No aliases</span>}
          </div>
          {!readOnly && (
          <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                run(async () => {
                  await api.post(`admin/mailboxes/${box.id}/aliases`, { address: alias });
                  setAlias("");
                }, "Alias added");
              }}
            >
              <Input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder={`e.g. sales@${box.address.split("@")[1]}`} type="email" />
              <Button type="submit" disabled={!alias}>Add alias</Button>
            </form>
          )}
        </section>

        {!readOnly && (
          <section className="rounded-ui border border-danger/30 p-4">
            <h3 className="text-[13px] font-semibold text-danger">Delete mailbox</h3>
            <p className="mt-1 mb-3 text-xs text-fg-muted">Permanently deletes the mailbox and every message in it.</p>
            <Button variant="danger" size="sm" icon={<Trash2 className="size-3.5" />} onClick={destroy}>
              Delete mailbox
            </Button>
          </section>
        )}
      </fieldset>
    </Modal>
  );
}

export function AdminMailboxes() {
  const { data: boxes = [], isLoading, error, refetch } = useQuery({ queryKey: ["admin-mailboxes"], queryFn: () => api.get<AdminMailbox[]>("admin/mailboxes") });
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const editable = useCanManage();
  const open = boxes.find((b) => b.id === openId);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Mailboxes"
        description="Every address your organization sends and receives from."
        actions={
          editable && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              New mailbox
            </Button>
          )
        }
      />
      {isLoading ? (
        <Spinner />
      ) : error ? (
        <Card>
          <LoadError error={error} onRetry={() => refetch()} />
        </Card>
      ) : boxes.length === 0 ? (
        <Card>
          <EmptyState icon={<Inbox className="size-5" />} title="No mailboxes yet" body="Create a shared mailbox, or invite users with a personal mailbox." />
        </Card>
      ) : (
        <Card className="divide-y divide-line">
          {boxes.map((b) => (
            <button key={b.id} onClick={() => setOpenId(b.id)} className="flex w-full items-center gap-4 px-5 py-3.5 text-left hover:bg-subtle">
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: b.color }} />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
                  <span className="truncate">{mailboxLabel(b)}</span>
                  <span className="truncate font-normal text-fg-muted">{b.address}</span>
                  <Badge>{b.type === "shared" ? "Shared" : "Personal"}</Badge>
                  {!b.isActive && <Badge tone="warning">Inactive</Badge>}
                  {b.isCatchAll && <Badge tone="accent">Catch-all</Badge>}
                </p>
                <p className="truncate text-xs text-fg-muted">
                  {b.displayName ? `Sends as “${b.displayName}”` : "No sender name"} · {b.members.length} member{b.members.length === 1 ? "" : "s"}
                  {b.aliases.length > 0 && ` · ${b.aliases.length} alias${b.aliases.length > 1 ? "es" : ""}`} · {b.messageCount.toLocaleString()} messages · {fileSize(b.storageBytes)}
                  {b.lastActivity && ` · active ${relativeTime(b.lastActivity)}`}
                </p>
              </div>
              <div className="hidden -space-x-1.5 sm:flex">
                {b.members.slice(0, 4).map((m) => (
                  <span key={m.userId} className="rounded-full ring-2 ring-surface">
                    <Avatar name={m.name} email={m.email} color={m.avatarColor} size={24} />
                  </span>
                ))}
              </div>
              <ChevronRight className="size-4 text-fg-faint" />
            </button>
          ))}
        </Card>
      )}
      {creating && <CreateDialog onClose={() => setCreating(false)} />}
      {open && <MailboxDetail key={open.id} box={open} readOnly={!editable} onClose={() => setOpenId(null)} />}
    </div>
  );
}
