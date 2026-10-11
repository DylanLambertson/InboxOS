import type { ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FingerprintPattern, Inbox, MonitorSmartphone, MoreHorizontal, ScrollText, ShieldCheck, UserRound, X } from "lucide-react";
import { toast } from "sonner";
import type { AdminUserRow } from "@shared/admin";
import { ACCESS_NAME } from "@shared/admin";
import type { MailboxRole } from "@shared/types";
import { api, errorMessage } from "@/lib/api";
import { longDate, mailboxLabel, relativeTime } from "@/lib/format";
import { Avatar, Badge, Button, IconButton, LoadError, Spinner } from "@/components/ui/primitives";
import { Menu, type MenuItem } from "@/components/ui/overlay";
import { Drawer } from "@/components/ui/drawer";

export interface UserDetail extends AdminUserRow {
  jobTitle: string;
  phone: string;
  department: string;
  timezone: string;
  updatedAt: string;
  scimManaged: boolean;
  legalHold: boolean;
  mailboxes: { id: string; address: string; name: string; displayName: string; type: string; color: string; isActive: boolean; role: MailboxRole }[];
  audit: { id: string; createdAt: string; actorEmail: string | null; action: string; byThem: boolean; meta: Record<string, unknown> }[];
}

interface SessionRow {
  id: string;
  ip: string | null;
  device: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

interface SignInRow {
  id: string;
  created_at: string;
  outcome: string;
  method: string;
  ip: string | null;
  device: string | null;
  country: string | null;
}

const ROLE_LABEL = { owner: "Owner", admin: "Admin", manager: "Manager", member: "Member" } as const;

function Section({ icon, title, action, children }: { icon: ReactNode; title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-[13px] font-semibold text-fg [&>svg]:size-4 [&>svg]:text-fg-muted">
          {icon} {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

const Empty = ({ children }: { children: ReactNode }) => <p className="rounded-ui border border-dashed border-line px-3 py-3 text-xs text-fg-muted">{children}</p>;

/** Everything about one person in one place: profile, access, security, sessions and history. */
export function UserDrawer({
  userId,
  onClose,
  menuItems,
  onAccess,
  canManage,
}: {
  userId: string;
  onClose: () => void;
  menuItems: (u: AdminUserRow) => MenuItem[];
  onAccess: (u: AdminUserRow) => void;
  canManage: (u: AdminUserRow) => boolean;
}) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ["admin-users", "detail", userId], queryFn: () => api.get<UserDetail>(`admin/users/${userId}`) });
  const sessions = useQuery({ queryKey: ["admin-sessions", "user", userId], queryFn: () => api.get<SessionRow[]>(`admin/security/sessions?user=${encodeURIComponent(userId)}`) });
  const signIns = useQuery({
    queryKey: ["admin-sign-ins", "user", userId],
    queryFn: () => api.get<{ items: SignInRow[] }>(`admin/security/sign-ins?user=${encodeURIComponent(userId)}&limit=8`),
  });
  const u = detail.data;
  const manage = !!u && canManage(u);

  const revoke = async (s: SessionRow) => {
    try {
      await api.del(`admin/security/sessions/${s.id}`);
      toast.success("Session ended");
      qc.invalidateQueries({ queryKey: ["admin-sessions"] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <Drawer
      open
      onClose={onClose}
      title={u ? u.name || u.email : "Loading…"}
      description={u ? u.email : undefined}
      actions={
        u && manage ? (
          <Menu align="end" width={240} items={menuItems(u)} trigger={(p) => (
            <IconButton label="Actions" size="sm" {...p}>
              <MoreHorizontal className="size-4" />
            </IconButton>
          )} />
        ) : undefined
      }
    >
      {detail.isLoading ? (
        <Spinner />
      ) : detail.error ? (
        <LoadError error={detail.error} onRetry={() => detail.refetch()} />
      ) : u ? (
        <div className="space-y-7">
          <div className="flex items-center gap-4">
            <Avatar name={u.name} email={u.email} color={u.avatarColor} src={u.avatarUrl} size={56} />
            <div className="flex flex-wrap gap-1.5">
              <Badge tone={u.role === "owner" || u.role === "admin" ? "accent" : "neutral"}>{ROLE_LABEL[u.role]}</Badge>
              {u.status === "active" && <Badge tone="success">Active</Badge>}
              {u.status === "invited" && <Badge tone="accent">Invited</Badge>}
              {u.status === "disabled" && <Badge>Disabled</Badge>}
              {u.lockedUntil && <Badge tone="warning">Locked until {longDate(u.lockedUntil)}</Badge>}
              {u.scimManaged && <Badge>Managed by SCIM</Badge>}
              {u.legalHold && <Badge tone="danger">Legal hold</Badge>}
            </div>
          </div>

          <Section icon={<UserRound />} title="Profile">
            <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-1.5 text-[13px]">
              <dt className="text-fg-muted">Job title</dt><dd>{u.jobTitle || "—"}</dd>
              <dt className="text-fg-muted">Department</dt><dd>{u.department || "—"}</dd>
              <dt className="text-fg-muted">Phone</dt><dd>{u.phone || "—"}</dd>
              <dt className="text-fg-muted">Time zone</dt><dd>{u.timezone || "—"}</dd>
              <dt className="text-fg-muted">Added</dt><dd>{longDate(u.createdAt)}</dd>
              <dt className="text-fg-muted">Last sign-in</dt><dd>{u.lastLoginAt ? relativeTime(u.lastLoginAt) : "Never"}</dd>
              {u.digest && (<><dt className="text-fg-muted">Reminders</dt><dd>Every {u.digest.hours}h to {u.digest.to}</dd></>)}
            </dl>
          </Section>

          <Section
            icon={<Inbox />}
            title={`Mailboxes (${u.mailboxes.length})`}
            action={<Button size="xs" onClick={() => onAccess(u)}>{manage ? "Manage access" : "View access"}</Button>}
          >
            {u.mailboxes.length ? (
              <ul className="divide-y divide-line rounded-ui border border-line">
                {u.mailboxes.map((m) => (
                  <li key={m.id} className="flex items-center gap-3 px-3 py-2">
                    <span className="size-2.5 shrink-0 rounded-full" style={{ background: m.color }} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{mailboxLabel(m)}</span>
                      <span className="block truncate text-xs text-fg-muted">{m.address}</span>
                    </span>
                    {m.type === "shared" && <Badge>Shared</Badge>}
                    {!m.isActive && <Badge tone="warning">Inactive</Badge>}
                    <span className="text-xs text-fg-muted">{ACCESS_NAME[m.role]}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No mailbox access yet.</Empty>
            )}
          </Section>

          <Section icon={<ShieldCheck />} title="Sign-in & security">
            <div className="flex flex-wrap gap-1.5">
              {u.totpEnabled ? <Badge tone="success">Authenticator app</Badge> : <Badge>No authenticator app</Badge>}
              {u.passkeyCount > 0 ? <Badge tone="success"><FingerprintPattern className="size-3" /> {u.passkeyCount} passkey{u.passkeyCount === 1 ? "" : "s"}</Badge> : <Badge>No passkeys</Badge>}
              {u.hasPassword ? <Badge>Password</Badge> : <Badge>No password</Badge>}
              {u.googleLinked && <Badge>Google</Badge>}
            </div>
          </Section>

          <Section icon={<MonitorSmartphone />} title="Active sessions">
            {sessions.isLoading ? (
              <Spinner />
            ) : sessions.data?.length ? (
              <ul className="divide-y divide-line rounded-ui border border-line">
                {sessions.data.map((s) => (
                  <li key={s.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{s.device} {s.current && <span className="text-xs text-fg-muted">(this session)</span>}</span>
                      <span className="block truncate text-xs text-fg-muted">{s.ip ?? "Unknown IP"} · active {relativeTime(s.lastSeenAt)}</span>
                    </span>
                    {manage && !s.current && (
                      <IconButton size="sm" label="End session" onClick={() => revoke(s)}>
                        <X className="size-4" />
                      </IconButton>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>Not signed in anywhere.</Empty>
            )}
          </Section>

          <Section icon={<ShieldCheck />} title="Recent sign-ins">
            {signIns.isLoading ? (
              <Spinner />
            ) : signIns.data?.items.length ? (
              <ul className="divide-y divide-line rounded-ui border border-line">
                {signIns.data.items.map((e) => (
                  <li key={e.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                    <Badge tone={e.outcome === "success" ? "success" : "danger"}>{e.outcome === "success" ? "Signed in" : e.outcome.replace(/_/g, " ")}</Badge>
                    <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">
                      {[e.device, e.ip, e.country, e.method].filter(Boolean).join(" · ")}
                    </span>
                    <span className="shrink-0 text-xs text-fg-muted">{relativeTime(e.created_at)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No sign-ins recorded.</Empty>
            )}
          </Section>

          <Section icon={<ScrollText />} title="Recent activity">
            {u.audit.length ? (
              <ul className="divide-y divide-line rounded-ui border border-line">
                {u.audit.map((a) => (
                  <li key={a.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-xs">{a.action}</span>
                      <span className="block truncate text-xs text-fg-muted">{a.byThem ? "By them" : `By ${a.actorEmail ?? "system"}`}</span>
                    </span>
                    <span className="shrink-0 text-xs text-fg-muted">{relativeTime(a.createdAt)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>Nothing yet.</Empty>
            )}
          </Section>
        </div>
      ) : null}
    </Drawer>
  );
}
