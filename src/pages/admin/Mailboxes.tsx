import { useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Download, Inbox, Plus, Upload } from "lucide-react";
import { listQuery, type AdminMailboxRow, type PageOf } from "@shared/admin";
import type { ImportKind } from "@shared/admin-import";
import { api } from "@/lib/api";
import { fileSize, mailboxLabel, relativeTime } from "@/lib/format";
import { useCanManage } from "@/lib/queries";
import { Avatar, Badge, Button, Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { Menu } from "@/components/ui/overlay";
import { ImportWizard } from "./import/ImportWizard";
import { CreateMailboxDialog } from "./mailboxes/CreateMailboxDialog";
import { MailboxBulkBar } from "./mailboxes/MailboxBulkBar";
import { MailboxDetail } from "./mailboxes/MailboxDetail";
import { DataTable, Pagination, selectionCount, useSelection, type Column } from "./table/DataTable";
import { FilterChip, SearchBox, useListState } from "./table/controls";

type MailboxesPage = PageOf<AdminMailboxRow> & { counts: Record<string, number> };
const FILTERS = ["type", "status", "members"] as const;

/**
 * Admin → Mailboxes: every address the organization sends and receives from, with
 * server-side search, filters, sort and paging, bulk actions, and CSV import/export
 * for mailboxes and aliases. Links: ?new=1 opens "New mailbox", ?open=<id> opens one.
 */
export function AdminMailboxes() {
  const editable = useCanManage();
  const qc = useQueryClient();
  const list = useListState(FILTERS, { sort: "address", dir: "asc" });
  const [params, setParams] = useSearchParams();
  const filterParams = { q: list.q, ...list.filters };
  const qs = listQuery({ ...filterParams, sort: list.sort, dir: list.dir, page: list.page, limit: list.limit });
  const query = useQuery({ queryKey: ["admin-mailboxes", "search", qs], queryFn: () => api.get<MailboxesPage>(`admin/mailboxes/search?${qs}`) });
  const data = query.data;
  const [selection, setSelection] = useSelection(listQuery({ ...filterParams, sort: list.sort, dir: list.dir }));
  const [creating, setCreating] = useState(params.get("new") === "1");
  const [importing, setImporting] = useState<ImportKind | null>(null);
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
  const count = selectionCount(selection, data?.total ?? 0);
  const targets = selection.all ? { filter: Object.fromEntries(Object.entries(filterParams).filter(([, v]) => v)) } : { ids: [...selection.ids] };
  const clear = () => setSelection({ all: false, ids: new Set() });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["admin-mailboxes"] });
    qc.invalidateQueries({ queryKey: ["admin-users"] });
    qc.invalidateQueries({ queryKey: ["mailboxes"] });
  };
  const filterQs = listQuery({ ...filterParams, sort: list.sort, dir: list.dir });

  const columns: Column<AdminMailboxRow>[] = [
    {
      key: "address",
      header: "Mailbox",
      sort: "address",
      render: (b) => (
        <div className="flex min-w-0 items-center gap-3">
          <span className="size-2.5 shrink-0 rounded-full" style={{ background: b.color }} />
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 truncate font-medium">
              <span className="truncate">{mailboxLabel(b)}</span>
              {b.isCatchAll && <Badge tone="accent">Catch-all</Badge>}
              {b.legalHold && <Badge tone="danger">Legal hold</Badge>}
            </p>
            <p className="truncate text-xs text-fg-muted">
              {b.address}
              {b.displayName && ` · sends as “${b.displayName}”`}
            </p>
          </div>
        </div>
      ),
    },
    { key: "type", header: "Type", sort: "type", render: (b) => <Badge>{b.type === "shared" ? "Shared" : "Personal"}</Badge> },
    {
      key: "members",
      header: "Members",
      sort: "members",
      firstDir: "desc",
      render: (b) => (
        <div className="flex items-center gap-2">
          <div className="flex -space-x-1.5">
            {b.members.slice(0, 4).map((m) => (
              <span key={m.userId} className="rounded-full ring-2 ring-surface" title={`${m.name || m.email}`}>
                <Avatar name={m.name} email={m.email} color={m.avatarColor} src={m.avatarUrl} size={22} />
              </span>
            ))}
          </div>
          <span className="tabular-nums text-fg-muted">{b.memberCount || <span className="text-warning">None</span>}</span>
        </div>
      ),
    },
    { key: "aliases", header: "Aliases", className: "tabular-nums text-fg-muted", render: (b) => b.aliasCount || "—" },
    {
      key: "messages",
      header: "Messages",
      className: "whitespace-nowrap tabular-nums text-fg-muted",
      render: (b) => `${b.messageCount.toLocaleString()} · ${fileSize(b.storageBytes)}`,
    },
    { key: "activity", header: "Last activity", className: "whitespace-nowrap text-fg-muted", render: (b) => (b.lastActivity ? relativeTime(b.lastActivity) : "—") },
    { key: "status", header: "Status", sort: "status", firstDir: "desc", render: (b) => (b.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="warning">Inactive</Badge>) },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Mailboxes"
        description={data ? `${(data.counts.shared ?? 0).toLocaleString()} shared · ${(data.counts.personal ?? 0).toLocaleString()} personal` : "Every address your organization sends and receives from."}
        actions={
          <>
            <Menu
              align="end"
              width={220}
              items={[
                { label: "Mailboxes and members", icon: <Download />, onSelect: () => window.location.assign(`/api/admin/mailboxes/export?${filterQs}`) },
                { label: "Aliases", icon: <Download />, onSelect: () => window.location.assign(`/api/admin/mailboxes/aliases/export?${filterQs}`) },
              ]}
              trigger={(p) => (
                <Button icon={<Download className="size-4" />} {...p}>
                  Export <ChevronDown className="size-3.5" />
                </Button>
              )}
            />
            {editable && (
              <>
                <Menu
                  align="end"
                  width={220}
                  items={[
                    { label: "Mailboxes", icon: <Upload />, onSelect: () => setImporting("mailboxes") },
                    { label: "Aliases", icon: <Upload />, onSelect: () => setImporting("aliases") },
                  ]}
                  trigger={(p) => (
                    <Button icon={<Upload className="size-4" />} {...p}>
                      Import <ChevronDown className="size-3.5" />
                    </Button>
                  )}
                />
                <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New mailbox</Button>
              </>
            )}
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={list.q} onChange={(q) => list.set({ q })} placeholder="Search address, name or alias" />
        <FilterChip label="Type" value={list.filters.type} options={[{ value: "shared", label: "Shared" }, { value: "personal", label: "Personal" }]} onChange={(v) => list.set({ type: v })} />
        <FilterChip label="Status" value={list.filters.status} options={[{ value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }]} onChange={(v) => list.set({ status: v })} />
        <FilterChip
          label="Members"
          value={list.filters.members}
          options={[{ value: "none", label: "No members" }, { value: "one", label: "One member" }, { value: "many", label: "Several members" }]}
          onChange={(v) => list.set({ members: v })}
        />
        {(list.activeFilters > 0 || list.q) && (
          <Button size="sm" variant="ghost" onClick={list.clearFilters}>Clear</Button>
        )}
      </div>
      {editable && count > 0 && <MailboxBulkBar count={count} targets={targets} onClear={clear} onDone={() => (refresh(), clear())} />}
      <Card className="overflow-hidden">
        <DataTable
          columns={columns}
          rows={data?.items ?? []}
          rowKey={(b) => b.id}
          rowLabel={(b) => b.address}
          sort={list.sort}
          dir={list.dir}
          onSort={(sort, dir) => list.set({ sort, dir })}
          total={data?.total ?? 0}
          noun="mailboxes"
          selection={editable ? selection : undefined}
          onSelection={editable ? setSelection : undefined}
          loading={query.isLoading}
          fetching={query.isFetching}
          error={query.error}
          onRetry={() => query.refetch()}
          onOpen={(b) => setOpen(b.id)}
          rowClassName={(b) => !b.isActive && "text-fg-muted"}
          empty={
            list.q || list.activeFilters ? (
              <EmptyState icon={<Inbox className="size-5" />} title="No mailboxes match" body="Try a different search or clear the filters." action={<Button size="sm" onClick={list.clearFilters}>Clear filters</Button>} />
            ) : (
              <EmptyState icon={<Inbox className="size-5" />} title="No mailboxes yet" body="Create a shared mailbox, invite people with a personal mailbox, or import a CSV." />
            )
          }
        />
        {data && data.total > 0 && <Pagination page={list.page} limit={list.limit} total={data.total} onPage={(page) => list.set({ page })} onLimit={(limit) => list.set({ limit })} />}
      </Card>
      {creating && <CreateMailboxDialog onClose={() => (setCreating(false), params.get("new") && setOpen(null))} onCreated={(id) => setOpen(id)} />}
      {importing && <ImportWizard kind={importing} onClose={() => setImporting(null)} onDone={refresh} />}
      {openId && <MailboxDetail key={openId} id={openId} readOnly={!editable} onClose={() => setOpen(null)} />}
    </div>
  );
}
