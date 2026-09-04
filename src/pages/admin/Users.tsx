import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Copy, Inbox, KeyRound, Lock, LogOut, MailPlus, MoreHorizontal, Search, ShieldOff, Trash2, UserCheck, UserPlus, UserX } from "lucide-react";
import { toast } from "sonner";
import type { MailboxRole, Role, UserStatus } from "@shared/types";
import { api, errorMessage } from "@/lib/api";
import { useBrand } from "@/lib/brand";
import { relativeTime } from "@/lib/format";
import { useMe } from "@/lib/queries";
import { Avatar, Badge, Button, Card, Field, IconButton, Input, PageHeader, Select, Spinner, Switch } from "@/components/ui/primitives";
import { Menu, Modal, useConfirm } from "@/components/ui/overlay";
import { AccessPicker, ManageAccessDialog } from "./MailboxAccess";

interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  avatarColor: string;
  totpEnabled: boolean;
  googleLinked: boolean;
  hasPassword: boolean;
  mailboxCount: number;
  lastLoginAt: string | null;
  lockedUntil: string | null;
  createdAt: string;
}

const ROLE_HELP: Record<Role, string> = {
  owner: "Full control, including security settings and other owners.",
  admin: "Manage users, mailboxes, branding and logs.",
  member: "Use the mailboxes they're given access to.",
};

function LinkResult({ url, emailed, kind }: { url: string; emailed: boolean; kind: "invite" | "reset" }) {
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-fg-muted">
        {emailed ? `We emailed the ${kind} link. You can also share it directly:` : `Email delivery isn't available — share this ${kind} link securely:`}
      </p>
      <div className="flex gap-2">
        <Input readOnly value={url} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
        <Button icon={<Copy className="size-4" />} onClick={() => (navigator.clipboard.writeText(url), toast.success("Link copied"))}>
          Copy
        </Button>
      </div>
    </div>
  );
}

function InviteDialog({ onClose }: { onClose: () => void }) {
  const brand = useBrand();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [createMailbox, setCreateMailbox] = useState(true);
  const [mailboxAddress, setMailboxAddress] = useState("");
  const [sendEmail, setSendEmail] = useState(true);
  const [access, setAccess] = useState<Record<string, MailboxRole>>({});
  const [showAccess, setShowAccess] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ inviteUrl: string; emailed: boolean } | null>(null);
  const suggested = email.toLowerCase().endsWith(`@${brand.primaryDomain}`) ? email.toLowerCase() : email ? `${email.split("@")[0].toLowerCase()}@${brand.primaryDomain}` : "";

  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ inviteUrl: string; emailed: boolean }>("admin/users", {
        email,
        name,
        role,
        sendEmail,
        access: Object.entries(access).map(([mailboxId, role]) => ({ mailboxId, role })),
        ...(createMailbox ? { mailboxAddress: (mailboxAddress || suggested).trim() } : {}),
      });
      setResult(r);
      qc.invalidateQueries({ queryKey: ["admin-users"] });
      qc.invalidateQueries({ queryKey: ["admin-mailboxes"] });
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
      title={result ? "Invite created" : "Invite a user"}
      description={result ? undefined : "They'll set their own password (or use Google) when they accept."}
      width={500}
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!email} onClick={submit}>
              Send invite
            </Button>
          </>
        )
      }
    >
      {result ? (
        <LinkResult url={result.inviteUrl} emailed={result.emailed} kind="invite" />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Email">
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@example.com" autoFocus />
            </Field>
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" />
            </Field>
          </div>
          <Field label="Role" hint={ROLE_HELP[role]}>
            <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
              {me?.role === "owner" && <option value="owner">Owner</option>}
            </Select>
          </Field>
          <div className="rounded-ui border border-line p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[13px] font-medium">Create a personal mailbox</p>
                <p className="text-xs text-fg-muted">They'll own it and can send from it right away.</p>
              </div>
              <Switch checked={createMailbox} onChange={setCreateMailbox} label="Create a personal mailbox" />
            </div>
            {createMailbox && (
              <Input className="mt-3" value={mailboxAddress} onChange={(e) => setMailboxAddress(e.target.value)} placeholder={suggested || `name@${brand.primaryDomain}`} />
            )}
          </div>
          <div className="rounded-ui border border-line">
            <button type="button" onClick={() => setShowAccess((v) => !v)} className="flex w-full items-center justify-between gap-3 p-3 text-left">
              <span>
                <span className="block text-[13px] font-medium">Access to other mailboxes</span>
                <span className="text-xs text-fg-muted">
                  {Object.keys(access).length ? `${Object.keys(access).length} selected` : "Shared inboxes like support@ or other people's mailboxes"}
                </span>
              </span>
              <ChevronDown className={`size-4 text-fg-muted transition ${showAccess ? "rotate-180" : ""}`} />
            </button>
            {showAccess && (
              <div className="border-t border-line p-3">
                <AccessPicker value={access} onChange={setAccess} />
              </div>
            )}
          </div>
          <label className="flex items-center justify-between gap-3 text-[13px]">
            Email the invite link
            <Switch checked={sendEmail} onChange={setSendEmail} label="Email the invite link" />
          </label>
        </div>
      )}
    </Modal>
  );
}

export function AdminUsers() {
  const { data: users = [], isLoading } = useQuery({ queryKey: ["admin-users"], queryFn: () => api.get<AdminUser[]>("admin/users") });
  const { data: me } = useMe();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [q, setQ] = useState("");
  const [inviting, setInviting] = useState(false);
  const [accessFor, setAccessFor] = useState<AdminUser | null>(null);
  const [link, setLink] = useState<{ url: string; emailed: boolean; kind: "invite" | "reset" } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin-users"] });

  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast.success(msg);
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const filtered = users.filter((u) => !q || `${u.name} ${u.email} ${u.role}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users"
        description={`${users.filter((u) => u.status === "active").length} active · ${users.filter((u) => u.status === "invited").length} invited`}
        actions={
          <Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setInviting(true)}>
            Invite user
          </Button>
        }
      />
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-faint" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search users" className="pl-8" />
      </div>
      <Card className="overflow-x-auto">
        {isLoading ? (
          <div className="p-6"><Spinner /></div>
        ) : (
          <table className="w-full min-w-[720px] text-[13px]">
            <thead className="border-b border-line text-left text-xs text-fg-muted">
              <tr>
                <th className="px-5 py-2.5 font-medium">User</th>
                <th className="px-3 py-2.5 font-medium">Role</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5 font-medium">Security</th>
                <th className="px-3 py-2.5 font-medium">Mailboxes</th>
                <th className="px-3 py-2.5 font-medium">Last sign-in</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {filtered.map((u) => {
                const self = u.id === me?.id;
                const canManage = me?.role === "owner" || u.role !== "owner";
                return (
                  <tr key={u.id} className="hover:bg-subtle">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <Avatar name={u.name} email={u.email} color={u.avatarColor} size={30} />
                        <div className="min-w-0">
                          <p className="truncate font-medium">{u.name || "—"} {self && <span className="text-xs font-normal text-fg-muted">(you)</span>}</p>
                          <p className="truncate text-xs text-fg-muted">{u.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <Select
                        value={u.role}
                        disabled={self || !canManage}
                        onChange={(e) => act(() => api.patch(`admin/users/${u.id}`, { role: e.target.value }), "Role updated")}
                        className="h-8 w-28 text-[13px]"
                      >
                        <option value="member">Member</option>
                        <option value="admin">Admin</option>
                        <option value="owner" disabled={me?.role !== "owner"}>Owner</option>
                      </Select>
                    </td>
                    <td className="px-3 py-3">
                      {u.status === "active" && !u.lockedUntil && <Badge tone="success">Active</Badge>}
                      {u.status === "invited" && <Badge tone="accent">Invited</Badge>}
                      {u.status === "disabled" && <Badge>Disabled</Badge>}
                      {u.lockedUntil && <Badge tone="warning"><Lock className="size-3" /> Locked</Badge>}
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap gap-1">
                        {u.totpEnabled ? <Badge tone="success">2FA</Badge> : <Badge>No 2FA</Badge>}
                        {u.googleLinked && <Badge>Google</Badge>}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <button
                        onClick={() => setAccessFor(u)}
                        className="inline-flex items-center gap-1.5 rounded-ui-sm px-2 py-1 tabular-nums text-fg hover:bg-muted"
                        title="Manage mailbox access"
                      >
                        <Inbox className="size-3.5 text-fg-muted" /> {u.mailboxCount}
                      </button>
                    </td>
                    <td className="px-3 py-3 text-fg-muted">{u.lastLoginAt ? relativeTime(u.lastLoginAt) : "Never"}</td>
                    <td className="px-3 py-3">
                      {canManage && (
                        <Menu
                          align="end"
                          width={230}
                          items={[
                            { label: "Manage mailbox access", icon: <Inbox />, onSelect: () => setAccessFor(u) },
                            { separator: true, label: "" },
                            ...(u.status === "invited"
                              ? [{
                                  label: "Resend invite",
                                  icon: <MailPlus />,
                                  onSelect: async () => {
                                    try {
                                      const r = await api.post<{ inviteUrl: string; emailed: boolean }>(`admin/users/${u.id}/invite`, { sendEmail: true });
                                      setLink({ url: r.inviteUrl, emailed: r.emailed, kind: "invite" });
                                    } catch (e) {
                                      toast.error(errorMessage(e));
                                    }
                                  },
                                }]
                              : []),
                            ...(u.status === "active"
                              ? [{
                                  label: "Send password reset",
                                  icon: <KeyRound />,
                                  onSelect: async () => {
                                    try {
                                      const r = await api.post<{ resetUrl: string; emailed: boolean }>(`admin/users/${u.id}/reset-password`);
                                      setLink({ url: r.resetUrl, emailed: r.emailed, kind: "reset" });
                                    } catch (e) {
                                      toast.error(errorMessage(e));
                                    }
                                  },
                                }]
                              : []),
                            ...(u.totpEnabled
                              ? [{
                                  label: "Reset two-factor",
                                  icon: <ShieldOff />,
                                  onSelect: async () => {
                                    if (await confirm({ title: `Reset 2FA for ${u.name || u.email}?`, body: "They'll be signed out and can sign in with just their password until they set it up again.", confirmLabel: "Reset 2FA", danger: true }))
                                      act(() => api.post(`admin/users/${u.id}/reset-2fa`), "Two-factor reset");
                                  },
                                }]
                              : []),
                            ...(u.lockedUntil ? [{ label: "Unlock account", icon: <Lock />, onSelect: () => act(() => api.patch(`admin/users/${u.id}`, { unlock: true }), "Account unlocked") }] : []),
                            { label: "Sign out everywhere", icon: <LogOut />, onSelect: () => act(() => api.post(`admin/users/${u.id}/sign-out`), "Signed out of all sessions") },
                            { separator: true, label: "" },
                            u.status === "disabled"
                              ? { label: "Enable account", icon: <UserCheck />, onSelect: () => act(() => api.patch(`admin/users/${u.id}`, { status: "active" }), "Account enabled") }
                              : {
                                  label: "Disable account",
                                  icon: <UserX />,
                                  disabled: self,
                                  onSelect: async () => {
                                    if (await confirm({ title: `Disable ${u.name || u.email}?`, body: "They'll be signed out immediately and can't sign in. Their mailboxes are kept.", confirmLabel: "Disable", danger: true }))
                                      act(() => api.patch(`admin/users/${u.id}`, { status: "disabled" }), "Account disabled");
                                  },
                                },
                            {
                              label: "Delete user",
                              icon: <Trash2 />,
                              danger: true,
                              disabled: self,
                              onSelect: async () => {
                                if (await confirm({ title: `Delete ${u.name || u.email}?`, body: "Their account is removed permanently. Mailboxes and messages are kept.", confirmLabel: "Delete user", danger: true, typeToConfirm: u.email }))
                                  act(() => api.del(`admin/users/${u.id}`), "User deleted");
                              },
                            },
                          ]}
                          trigger={(p) => (
                            <IconButton label="Actions" size="sm" {...p}>
                              <MoreHorizontal className="size-4" />
                            </IconButton>
                          )}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
      {inviting && <InviteDialog onClose={() => setInviting(false)} />}
      {accessFor && <ManageAccessDialog user={accessFor} onClose={() => setAccessFor(null)} />}
      <Modal open={!!link} onClose={() => setLink(null)} title={link?.kind === "invite" ? "Invite link" : "Password reset link"} footer={<Button variant="primary" onClick={() => setLink(null)}>Done</Button>}>
        {link && <LinkResult url={link.url} emailed={link.emailed} kind={link.kind} />}
      </Modal>
    </div>
  );
}
