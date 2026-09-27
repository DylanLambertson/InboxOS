import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Inbox, Lock, Plus, Unlock, User } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { longDate, relativeTime } from "@/lib/format";
import { Badge, Button, Card, EmptyState, Field, Input, LoadError, Select, Spinner, Textarea } from "@/components/ui/primitives";
import { Modal, Tabs, useConfirm } from "@/components/ui/overlay";
import { useAdminMailboxes } from "./MailboxAccess";
import { OwnerOnlyNote, useIsOwner } from "./Compliance";

interface Hold {
  id: string;
  name: string;
  reason: string;
  target: { type: "mailbox" | "user"; id: string; label: string };
  createdBy: string | null;
  createdAt: string;
  releasedAt: string | null;
  releasedBy: string | null;
}

/** Compliance → Legal holds. */
export function LegalHolds() {
  const isOwner = useIsOwner();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [placing, setPlacing] = useState(false);
  const { data, error, refetch, isLoading } = useQuery({
    queryKey: ["admin-holds"],
    queryFn: () => api.get<{ heldMailboxes: number; items: Hold[] }>("admin/compliance/holds"),
  });

  const release = async (h: Hold) => {
    const ok = await confirm({
      title: `Release “${h.name}”?`,
      body: `Mail for ${h.target.label} can be deleted again: by people emptying Trash, and by retention policies. Only release a hold when the matter is closed.`,
      confirmLabel: "Release hold",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.post(`admin/compliance/holds/${h.id}/release`);
      qc.invalidateQueries({ queryKey: ["admin-holds"] });
      qc.invalidateQueries({ queryKey: ["admin-mailboxes"] });
      qc.invalidateQueries({ queryKey: ["admin-retention"] });
      toast.success("Hold released");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const active = data?.items.filter((h) => !h.releasedAt) ?? [];
  const released = data?.items.filter((h) => h.releasedAt) ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-[13px] text-fg-muted">
          While a mailbox is on hold, nothing in it can be permanently deleted by anyone: not by emptying Trash, deleting forever, retention policies or deleting the mailbox.
          People can still move mail to Trash; it's simply kept there.
        </p>
        {isOwner && (
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setPlacing(true)}>
            Place a hold
          </Button>
        )}
      </div>
      {!isOwner && <OwnerOnlyNote>Only owners can place or release legal holds.</OwnerOnlyNote>}

      {error ? (
        <LoadError error={error} onRetry={refetch} />
      ) : isLoading ? (
        <Spinner />
      ) : (
        <>
          <Card>
            {active.length === 0 ? (
              <EmptyState icon={<Lock className="size-5" />} title="No active holds" body="Place a hold when mail must be preserved for a legal matter or investigation." />
            ) : (
              <ul className="divide-y divide-line">
                {active.map((h) => (
                  <HoldRow key={h.id} hold={h} onRelease={isOwner ? () => release(h) : undefined} />
                ))}
              </ul>
            )}
          </Card>
          {released.length > 0 && (
            <div>
              <h3 className="mb-2 text-xs font-medium tracking-wide text-fg-muted uppercase">Released</h3>
              <Card>
                <ul className="divide-y divide-line">
                  {released.map((h) => (
                    <HoldRow key={h.id} hold={h} />
                  ))}
                </ul>
              </Card>
            </div>
          )}
        </>
      )}
      {placing && <PlaceHoldDialog onClose={() => setPlacing(false)} />}
    </div>
  );
}

function HoldRow({ hold: h, onRelease }: { hold: Hold; onRelease?: () => void }) {
  return (
    <li className="flex items-start gap-3 px-5 py-3.5">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-fg-muted">
        {h.target.type === "mailbox" ? <Inbox className="size-4" /> : <User className="size-4" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className="font-medium">{h.name}</span>
          {h.releasedAt ? <Badge>Released</Badge> : <Badge tone="danger">Active</Badge>}
          <span className="text-fg-muted">{h.target.type === "user" ? `${h.target.label} (all their mailboxes)` : h.target.label}</span>
        </p>
        {h.reason && <p className="mt-0.5 text-xs whitespace-pre-wrap text-fg-muted">{h.reason}</p>}
        <p className="mt-0.5 text-[11px] text-fg-faint" title={longDate(h.createdAt)}>
          Placed {relativeTime(h.createdAt)}
          {h.createdBy && ` by ${h.createdBy}`}
          {h.releasedAt && ` · released ${relativeTime(h.releasedAt)}${h.releasedBy ? ` by ${h.releasedBy}` : ""}`}
        </p>
      </div>
      {onRelease && (
        <Button size="sm" icon={<Unlock className="size-3.5" />} onClick={onRelease}>
          Release
        </Button>
      )}
    </li>
  );
}

function PlaceHoldDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: boxes = [] } = useAdminMailboxes();
  const { data: users = [] } = useQuery({ queryKey: ["admin-users"], queryFn: () => api.get<{ id: string; name: string; email: string }[]>("admin/users") });
  const [kind, setKind] = useState<"mailbox" | "user">("mailbox");
  const [target, setTarget] = useState("");
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await api.post("admin/compliance/holds", { name, reason, ...(kind === "mailbox" ? { mailboxId: target } : { userId: target }) });
      qc.invalidateQueries({ queryKey: ["admin-holds"] });
      qc.invalidateQueries({ queryKey: ["admin-mailboxes"] });
      qc.invalidateQueries({ queryKey: ["admin-retention"] });
      toast.success("Hold placed. Nothing in it can be permanently deleted now.");
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
      title="Place a legal hold"
      description="Preserves mail exactly as it is now and everything that arrives later. The hold and who placed it are recorded in the audit log."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim() || !target} onClick={submit}>
            Place hold
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme v. Example — 2026" maxLength={120} autoFocus />
        </Field>
        <Field label="Reason" hint="Optional. Who asked for it, case number, and so on.">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={2000} />
        </Field>
        <Field label="Hold">
          <Tabs
            value={kind}
            onChange={(v) => (setKind(v), setTarget(""))}
            tabs={[
              { value: "mailbox", label: "A mailbox" },
              { value: "user", label: "A person" },
            ]}
          />
        </Field>
        {kind === "mailbox" ? (
          <Select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Mailbox">
            <option value="">Choose a mailbox…</option>
            {boxes.map((b) => (
              <option key={b.id} value={b.id}>
                {b.address}
              </option>
            ))}
          </Select>
        ) : (
          <>
            <Select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Person">
              <option value="">Choose a person…</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name ? `${u.name} (${u.email})` : u.email}
                </option>
              ))}
            </Select>
            <p className="text-xs text-fg-muted">Covers every mailbox they belong to now or join later. They can't be deleted while the hold is active.</p>
          </>
        )}
      </div>
    </Modal>
  );
}
