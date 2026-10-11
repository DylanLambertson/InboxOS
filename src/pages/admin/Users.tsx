import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, Download, FingerprintPattern, Inbox, Lock, MoreHorizontal, Upload, UserPlus, Users as UsersIcon } from "lucide-react";
import { listQuery, SIGN_IN_FILTERS, SIGN_IN_LABEL, type AdminUserRow, type PageOf } from "@shared/admin";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { useCanManage } from "@/lib/queries";
import { Avatar, Badge, Button, Card, EmptyState, IconButton, PageHeader, Select } from "@/components/ui/primitives";
import { Menu } from "@/components/ui/overlay";
import { ManageAccessDialog } from "./MailboxAccess";
import { ImportWizard } from "./import/ImportWizard";
import { DataTable, Pagination, selectionCount, useSelection, type Column } from "./table/DataTable";
import { FilterChip, SearchBox, useListState } from "./table/controls";
import { InviteDialog } from "./users/InviteDialog";
import { UserBulkBar } from "./users/UserBulkBar";
import { UserDrawer } from "./users/UserDrawer";
import { useUserActions } from "./users/useUserActions";

type UsersPage = PageOf<AdminUserRow> & { counts: Record<string, number> };
const FILTERS = ["role", "status", "twoFactor", "signIn"] as const;

const ROLE_OPTIONS = [
  { value: "owner", label: "Owner" },
  { value: "admin", label: "Admin" },
  { value: "manager", label: "Manager" },
  { value: "member", label: "Member" },
];
const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "invited", label: "Invited" },
  { value: "disabled", label: "Disabled" },
  { value: "locked", label: "Locked" },
];

/**
 * Admin → Users. Search, filters, sort and page are server-side (and kept in the URL),
 * so it stays fast with thousands of people. Select rows (shift-click for a range, or
 * "select all matching") for bulk actions; click a row for everything about a person.
 * Links from the command palette: ?new=1 opens the invite, ?q=<email> finds and opens someone, ?open=<id> opens them.
 */
export function AdminUsers() {
  const editable = useCanManage();
  const qc = useQueryClient();
  const list = useListState(FILTERS, { sort: "name", dir: "asc" });
  const [params, setParams] = useSearchParams();
  const filterParams = { q: list.q, ...list.filters };
  const qs = listQuery({ ...filterParams, sort: list.sort, dir: list.dir, page: list.page, limit: list.limit });
  const query = useQuery({ queryKey: ["admin-users", "search", qs], queryFn: () => api.get<UsersPage>(`admin/users/search?${qs}`) });
  const data = query.data;
  const [selection, setSelection] = useSelection(listQuery({ ...filterParams, sort: list.sort, dir: list.dir }));
  const [inviting, setInviting] = useState(params.get("new") === "1");
  const [importing, setImporting] = useState(false);
  const [accessFor, setAccessFor] = useState<AdminUserRow | null>(null);
  const openId = params.get("open");
  const setOpen = (id: string | null) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id) next.set("open", id);
        else next.delete("open");
        next.delete("new");
        return next;
      },
      { replace: true },
    );
  const actions = useUserActions({ onAccess: setAccessFor, onDeleted: () => setOpen(null) });

  // ?q=<email> from the command palette: open that person when the search finds them exactly.
  const autoOpened = useRef("");
  useEffect(() => {
    const q = list.q.toLowerCase();
    if (!q.includes("@") || autoOpened.current === q || !data || query.isPlaceholderData) return;
    const hit = data.items.find((u) => u.email.toLowerCase() === q);
    autoOpened.current = q;
    if (hit) setOpen(hit.id);
    // Only when results for this search arrive.
  }, [data, list.q, query.isPlaceholderData]);

  const count = selectionCount(selection, data?.total ?? 0);
  const targets = selection.all ? { filter: Object.fromEntries(Object.entries(filterParams).filter(([, v]) => v)) } : { ids: [...selection.ids] };
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["admin-users"] });
    qc.invalidateQueries({ queryKey: ["admin-mailboxes"] });
  };
  const exportHref = `/api/admin/users/export?${listQuery({ ...filterParams, sort: list.sort, dir: list.dir })}`;

  const columns: Column<AdminUserRow>[] = [
    {
      key: "user",
      header: "User",
      sort: "name",
      render: (u) => (
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={u.name} email={u.email} color={u.avatarColor} src={u.avatarUrl} size={30} />
          <div className="min-w-0">
            <p className="truncate font-medium">
              {u.name || "—"} {u.id === actions.me?.id && <span className="text-xs font-normal text-fg-muted">(you)</span>}
            </p>
            <p className="truncate text-xs text-fg-muted">{u.email}</p>
          </div>
        </div>
      ),
    },
    {
      key: "role",
      header: "Role",
      sort: "role",
      render: (u) => (
        <Select
          value={u.role}
          disabled={u.id === actions.me?.id || !actions.canManage(u)}
          onChange={(e) => actions.changeRole(u, e.target.value)}
          className="h-8 w-28 text-[13px]"
          aria-label={`Role for ${u.email}`}
        >
          {ROLE_OPTIONS.map((r) => (
            <option key={r.value} value={r.value} disabled={r.value === "owner" && actions.me?.role !== "owner"}>{r.label}</option>
          ))}
        </Select>
      ),
    },
    {
      key: "status",
      header: "Status",
      sort: "status",
      render: (u) => (
        <div className="flex flex-wrap gap-1">
          {u.status === "active" && !u.lockedUntil && <Badge tone="success">Active</Badge>}
          {u.status === "invited" && <Badge tone="accent">Invited</Badge>}
          {u.status === "disabled" && <Badge>Disabled</Badge>}
          {u.lockedUntil && <Badge tone="warning"><Lock className="size-3" /> Locked</Badge>}
          {u.digest && (
            <span title={`Unread-mail reminders every ${u.digest.hours}h to ${u.digest.to}`}>
              <Badge><BellRing className="size-3" /> Digest</Badge>
            </span>
          )}
        </div>
      ),
    },
    {
      key: "security",
      header: "Security",
      render: (u) => (
        <div className="flex flex-wrap gap-1">
          {u.totpEnabled ? <Badge tone="success">2FA</Badge> : u.passkeyCount ? null : <Badge>No 2FA</Badge>}
          {u.passkeyCount > 0 && (
            <span title={`${u.passkeyCount} passkey${u.passkeyCount === 1 ? "" : "s"}`}>
              <Badge tone="success"><FingerprintPattern className="size-3" /> Passkey</Badge>
            </span>
          )}
          {u.googleLinked && <Badge>Google</Badge>}
        </div>
      ),
    },
    {
      key: "mailboxes",
      header: "Mailboxes",
      sort: "mailboxes",
      firstDir: "desc",
      render: (u) => (
        <button onClick={() => setAccessFor(u)} className="inline-flex items-center gap-1.5 rounded-ui-sm px-2 py-1 tabular-nums text-fg hover:bg-muted" title="Mailbox access">
          <Inbox className="size-3.5 text-fg-muted" /> {u.mailboxCount}
        </button>
      ),
    },
    { key: "lastLogin", header: "Last sign-in", sort: "lastLogin", firstDir: "desc", className: "whitespace-nowrap text-fg-muted", render: (u) => (u.lastLoginAt ? relativeTime(u.lastLoginAt) : "Never") },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      className: "w-10",
      render: (u) =>
        actions.canManage(u) ? (
          <Menu align="end" width={240} items={actions.items(u)} trigger={(p) => (
            <IconButton label="Actions" size="sm" {...p}>
              <MoreHorizontal className="size-4" />
            </IconButton>
          )} />
        ) : null,
    },
  ];

  const c = data?.counts ?? {};
  return (
    <div className="space-y-4">
      <PageHeader
        title="Users"
        description={data ? `${(c.active ?? 0).toLocaleString()} active · ${(c.invited ?? 0).toLocaleString()} invited · ${(c.disabled ?? 0).toLocaleString()} disabled` : "Everyone who can sign in."}
        actions={
          <>
            <a href={exportHref} download>
              <Button icon={<Download className="size-4" />}>Export</Button>
            </a>
            {editable && (
              <>
                <Button icon={<Upload className="size-4" />} onClick={() => setImporting(true)}>Import</Button>
                <Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setInviting(true)}>Invite user</Button>
              </>
            )}
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={list.q} onChange={(q) => list.set({ q })} placeholder="Search name, email or mailbox" />
        <FilterChip label="Role" value={list.filters.role} options={ROLE_OPTIONS} onChange={(v) => list.set({ role: v })} />
        <FilterChip label="Status" value={list.filters.status} options={STATUS_OPTIONS} onChange={(v) => list.set({ status: v })} />
        <FilterChip label="2FA" value={list.filters.twoFactor} options={[{ value: "on", label: "On" }, { value: "off", label: "Off" }]} onChange={(v) => list.set({ twoFactor: v })} />
        <FilterChip label="Sign-in" value={list.filters.signIn} options={SIGN_IN_FILTERS.map((v) => ({ value: v, label: SIGN_IN_LABEL[v] }))} onChange={(v) => list.set({ signIn: v })} />
        {(list.activeFilters > 0 || list.q) && (
          <Button size="sm" variant="ghost" onClick={list.clearFilters}>Clear</Button>
        )}
      </div>
      {editable && count > 0 && <UserBulkBar count={count} targets={targets} onClear={() => setSelection({ all: false, ids: new Set() })} onDone={() => (refresh(), setSelection({ all: false, ids: new Set() }))} />}
      <Card className="overflow-hidden">
        <DataTable
          columns={columns}
          rows={data?.items ?? []}
          rowKey={(u) => u.id}
          rowLabel={(u) => u.name || u.email}
          sort={list.sort}
          dir={list.dir}
          onSort={(sort, dir) => list.set({ sort, dir })}
          total={data?.total ?? 0}
          noun="people"
          selection={editable ? selection : undefined}
          onSelection={editable ? setSelection : undefined}
          loading={query.isLoading}
          fetching={query.isFetching}
          error={query.error}
          onRetry={() => query.refetch()}
          onOpen={(u) => setOpen(u.id)}
          rowClassName={(u) => u.status === "disabled" && "text-fg-muted"}
          empty={
            list.q || list.activeFilters ? (
              <EmptyState icon={<UsersIcon className="size-5" />} title="No one matches" body="Try a different search or clear the filters." action={<Button size="sm" onClick={list.clearFilters}>Clear filters</Button>} />
            ) : (
              <EmptyState icon={<UsersIcon className="size-5" />} title="No users yet" body="Invite people one by one, or import a CSV." />
            )
          }
        />
        {data && data.total > 0 && <Pagination page={list.page} limit={list.limit} total={data.total} onPage={(page) => list.set({ page })} onLimit={(limit) => list.set({ limit })} />}
      </Card>
      {inviting && <InviteDialog onClose={() => (setInviting(false), params.get("new") && setOpen(null))} />}
      {importing && <ImportWizard kind="users" onClose={() => setImporting(false)} onDone={refresh} />}
      {openId && <UserDrawer userId={openId} onClose={() => setOpen(null)} menuItems={actions.items} onAccess={setAccessFor} canManage={actions.canManage} />}
      {accessFor && <ManageAccessDialog user={accessFor} readOnly={!editable} onClose={() => setAccessFor(null)} />}
      {actions.linkModal}
    </div>
  );
}
