import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Lock, Pencil } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { useMe } from "@/lib/queries";
import { Badge, Button, Card, Field, IconButton, Input, LoadError, PageHeader, Section, Select, Spinner, Switch } from "@/components/ui/primitives";
import { Modal, Tabs, useConfirm } from "@/components/ui/overlay";
import { LegalHolds } from "./ComplianceHolds";
import { Discovery } from "./ComplianceDiscovery";

type Scope = "all" | "archive";
type Tab = "retention" | "holds" | "ediscovery";

interface RetentionData {
  org: { retentionDays: number; retentionScope: Scope };
  mailboxes: { id: string; address: string; name: string; retentionDays: number | null; retentionScope: Scope | null; held: boolean }[];
}
interface Preview {
  total: number;
  heldExcluded: number;
}

const SCOPE_LABEL: Record<Scope, string> = { all: "All mail except drafts and scheduled", archive: "Archive only" };

export const useIsOwner = () => useMe().data?.role === "owner";

/** Admin → Compliance: retention, legal holds and eDiscovery. */
export function AdminCompliance() {
  const [tab, setTab] = useState<Tab>("retention");
  return (
    <div className="space-y-6">
      <PageHeader title="Compliance" description="Decide how long mail is kept, preserve mail for legal matters, and search across every mailbox when you need to." />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "retention", label: "Retention" },
          { value: "holds", label: "Legal holds" },
          { value: "ediscovery", label: "eDiscovery" },
        ]}
      />
      {tab === "retention" && <Retention />}
      {tab === "holds" && <LegalHolds />}
      {tab === "ediscovery" && <Discovery />}
    </div>
  );
}

export function OwnerOnlyNote({ children }: { children: string }) {
  return (
    <p className="flex items-center gap-2 rounded-ui border border-line bg-subtle px-3 py-2 text-xs text-fg-muted">
      <Eye className="size-3.5 shrink-0" /> {children}
    </p>
  );
}

const usePreview = (params: Record<string, string> | null) =>
  useQuery({
    queryKey: ["retention-preview", params],
    queryFn: () => api.get<Preview>(`admin/compliance/retention/preview?${new URLSearchParams(params ?? {})}`),
    enabled: !!params,
  });

function PreviewLine({ params }: { params: Record<string, string> | null }) {
  const { data, isFetching, error } = usePreview(params);
  if (!params) return <p className="text-xs text-fg-muted">Nothing will be deleted.</p>;
  if (error) return <p className="text-xs text-danger">{errorMessage(error)}</p>;
  if (isFetching || !data) return <Spinner className="size-3.5" />;
  return (
    <p className="text-xs text-fg-muted">
      Right now this would permanently delete <strong className="text-fg tabular-nums">{data.total.toLocaleString()}</strong> message{data.total === 1 ? "" : "s"}
      {data.heldExcluded > 0 && <> ({data.heldExcluded.toLocaleString()} more are kept by legal holds)</>}.
    </p>
  );
}

const ruleLabel = (days: number | null, scope: Scope | null) =>
  days === null ? "Follows the organization" : days === 0 ? "Keep forever" : `${days} days · ${scope === "archive" ? "Archive only" : "All mail"}`;

function Retention() {
  const isOwner = useIsOwner();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data, error, refetch } = useQuery({ queryKey: ["admin-retention"], queryFn: () => api.get<RetentionData>("admin/compliance/retention") });
  const [enabled, setEnabled] = useState(false);
  const [days, setDays] = useState(365);
  const [scope, setScope] = useState<Scope>("all");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<RetentionData["mailboxes"][number] | null>(null);

  useEffect(() => {
    if (!data) return;
    setEnabled(data.org.retentionDays > 0);
    if (data.org.retentionDays > 0) setDays(data.org.retentionDays);
    setScope(data.org.retentionScope);
  }, [data]);

  if (error) return <LoadError error={error} onRetry={refetch} />;
  if (!data) return <Spinner />;

  const nextDays = enabled ? days : 0;
  const changed = nextDays !== data.org.retentionDays || scope !== data.org.retentionScope;
  const params = enabled && days > 0 ? { days: String(days), scope } : null;

  const save = async () => {
    if (enabled) {
      const preview = await qc.fetchQuery({
        queryKey: ["retention-preview", params],
        queryFn: () => api.get<Preview>(`admin/compliance/retention/preview?${new URLSearchParams(params ?? {})}`),
      });
      const ok = await confirm({
        title: "Turn on automatic deletion?",
        body: `Mail older than ${days} days (${SCOPE_LABEL[scope].toLowerCase()}) will be permanently deleted every hour, starting with about ${preview.total.toLocaleString()} message(s). This can't be undone. Mail under legal hold is never deleted.`,
        confirmLabel: "Save and start deleting",
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await api.put("admin/compliance/retention", { retentionDays: nextDays, retentionScope: scope });
      qc.invalidateQueries({ queryKey: ["admin-retention"] });
      qc.invalidateQueries({ queryKey: ["admin-settings"] });
      toast.success(enabled ? "Retention policy saved" : "Automatic deletion turned off");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {!isOwner && <OwnerOnlyNote>Only owners can change retention. You can see the current settings.</OwnerOnlyNote>}
      <Section
        title="Organization retention"
        description="Permanently delete mail once it's older than a set age. Off by default. Runs hourly in small batches; held mailboxes are skipped."
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-6">
            <p className="text-[13px] font-medium">Delete old mail automatically</p>
            <Switch checked={enabled} onChange={setEnabled} disabled={!isOwner} label="Delete old mail automatically" />
          </div>
          {enabled && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Delete mail older than">
                <div className="flex items-center gap-2">
                  <Input type="number" min={1} max={36500} value={days} disabled={!isOwner} onChange={(e) => setDays(Math.max(1, parseInt(e.target.value || "1", 10)))} className="w-32" />
                  <span className="text-[13px] text-fg-muted">days</span>
                </div>
              </Field>
              <Field label="Applies to">
                <Select value={scope} disabled={!isOwner} onChange={(e) => setScope(e.target.value as Scope)}>
                  <option value="all">{SCOPE_LABEL.all}</option>
                  <option value="archive">{SCOPE_LABEL.archive}</option>
                </Select>
              </Field>
            </div>
          )}
          <PreviewLine params={params} />
          {isOwner && (
            <div className="flex justify-end">
              <Button variant="primary" disabled={!changed} loading={busy} onClick={save}>
                Save
              </Button>
            </div>
          )}
        </div>
      </Section>

      <Card>
        <div className="border-b border-line px-5 py-4">
          <h2 className="text-sm font-semibold">Mailbox overrides</h2>
          <p className="mt-0.5 text-[13px] text-fg-muted">Give a mailbox its own rule, or keep its mail forever.</p>
        </div>
        <ul className="divide-y divide-line">
          {data.mailboxes.map((b) => (
            <li key={b.id} className="flex items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span className="truncate font-medium">{b.name || b.address}</span>
                  <span className="truncate text-fg-muted">{b.address}</span>
                  {b.held && (
                    <Badge tone="danger">
                      <Lock className="size-3" /> Legal hold
                    </Badge>
                  )}
                </p>
                <p className="text-xs text-fg-muted">{ruleLabel(b.retentionDays, b.retentionScope)}</p>
              </div>
              {isOwner && (
                <IconButton label="Change retention" onClick={() => setEditing(b)}>
                  <Pencil className="size-4" />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      </Card>
      {editing && <OverrideDialog box={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function OverrideDialog({ box, onClose }: { box: RetentionData["mailboxes"][number]; onClose: () => void }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<"inherit" | "forever" | "custom">(box.retentionDays === null ? "inherit" : box.retentionDays === 0 ? "forever" : "custom");
  const [days, setDays] = useState(box.retentionDays || 365);
  const [scope, setScope] = useState<Scope>(box.retentionScope ?? "all");
  const [busy, setBusy] = useState(false);
  const retentionDays = mode === "inherit" ? null : mode === "forever" ? 0 : days;
  const params = { mailboxId: box.id, days: retentionDays === null ? "" : String(retentionDays), scope };

  const save = async () => {
    setBusy(true);
    try {
      await api.put(`admin/compliance/retention/mailboxes/${box.id}`, { retentionDays, retentionScope: mode === "custom" ? scope : null });
      qc.invalidateQueries({ queryKey: ["admin-retention"] });
      toast.success("Saved");
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
      title={`Retention for ${box.address}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Rule">
          <Select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="inherit">Follow the organization</option>
            <option value="forever">Keep forever</option>
            <option value="custom">Custom</option>
          </Select>
        </Field>
        {mode === "custom" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Delete mail older than">
              <div className="flex items-center gap-2">
                <Input type="number" min={1} max={36500} value={days} onChange={(e) => setDays(Math.max(1, parseInt(e.target.value || "1", 10)))} className="w-28" />
                <span className="text-[13px] text-fg-muted">days</span>
              </div>
            </Field>
            <Field label="Applies to">
              <Select value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
                <option value="all">All mail</option>
                <option value="archive">Archive only</option>
              </Select>
            </Field>
          </div>
        )}
        {box.held ? <p className="text-xs text-fg-muted">This mailbox is under legal hold, so nothing will be deleted until the hold is released.</p> : <PreviewLine params={params} />}
      </div>
    </Modal>
  );
}
