import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Inbox, Search } from "lucide-react";
import { toast } from "sonner";
import type { MailboxRole } from "@shared/types";
import { api, errorMessage } from "@/lib/api";
import { mailboxLabel } from "@/lib/format";
import { Badge, Button, cx, EmptyState, Input, Select, Spinner } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlay";

export interface AccessMailbox {
  id: string;
  address: string;
  name: string;
  displayName: string;
  type: "personal" | "shared";
  color: string;
  isActive: boolean;
  members: { userId: string; role: MailboxRole }[];
}

type Access = MailboxRole | "";
export const ACCESS_LABEL: Record<MailboxRole, string> = { owner: "Owner", editor: "Can send", viewer: "Read only" };

export const useAdminMailboxes = () => useQuery({ queryKey: ["admin-mailboxes"], queryFn: () => api.get<AccessMailbox[]>("admin/mailboxes") });

/** Filterable list of mailboxes with an access level per row. */
function AccessList({ boxes, value, onChange, busy }: { boxes: AccessMailbox[]; value: (id: string) => Access; onChange: (id: string, v: Access) => void; busy?: string | null }) {
  const [q, setQ] = useState("");
  const shown = boxes.filter((b) => !q || `${b.address} ${b.name} ${b.displayName}`.toLowerCase().includes(q.toLowerCase()));
  const granted = boxes.filter((b) => value(b.id)).length;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {boxes.length > 6 && (
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-faint" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter mailboxes" className="pl-8" />
          </div>
        )}
        <span className="ml-auto text-xs text-fg-muted">
          {granted} of {boxes.length} mailbox{boxes.length === 1 ? "" : "es"}
        </span>
      </div>
      <div className="max-h-80 divide-y divide-line overflow-y-auto rounded-ui border border-line">
        {shown.map((b) => {
          const v = value(b.id);
          return (
            <div key={b.id} className={cx("flex items-center gap-3 px-3 py-2", v && "bg-accent-softer")}>
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: b.color }} />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 truncate text-[13px] font-medium">
                  <span className="truncate">{mailboxLabel(b)}</span>
                  {b.type === "shared" && <Badge>Shared</Badge>}
                  {!b.isActive && <Badge tone="warning">Inactive</Badge>}
                </p>
                <p className="truncate text-xs text-fg-muted">{b.address}</p>
              </div>
              {busy === b.id && <Spinner />}
              <Select value={v} onChange={(e) => onChange(b.id, e.target.value as Access)} className="h-8 w-32 text-[13px]" aria-label={`Access to ${b.address}`}>
                <option value="">No access</option>
                <option value="viewer">{ACCESS_LABEL.viewer}</option>
                <option value="editor">{ACCESS_LABEL.editor}</option>
                <option value="owner">{ACCESS_LABEL.owner}</option>
              </Select>
            </div>
          );
        })}
        {!shown.length && <p className="px-3 py-4 text-center text-xs text-fg-muted">No mailboxes match.</p>}
      </div>
      <p className="text-xs text-fg-muted">
        <b>Read only</b> can read and organize. <b>Can send</b> can also reply and send. <b>Owner</b> can also change the sender name and signature.
      </p>
    </div>
  );
}

/** Controlled picker for the invite form (nothing is saved until the invite is sent). */
export function AccessPicker({ value, onChange }: { value: Record<string, MailboxRole>; onChange: (v: Record<string, MailboxRole>) => void }) {
  const { data: boxes = [], isLoading } = useAdminMailboxes();
  if (isLoading) return <Spinner />;
  if (!boxes.length) return <p className="text-xs text-fg-muted">No other mailboxes yet.</p>;
  return (
    <AccessList
      boxes={boxes}
      value={(id) => value[id] ?? ""}
      onChange={(id, v) => {
        const next = { ...value };
        if (v) next[id] = v;
        else delete next[id];
        onChange(next);
      }}
    />
  );
}

/** Live editor: changes apply immediately for an existing user. */
export function ManageAccessDialog({ user, onClose, readOnly }: { user: { id: string; name: string; email: string }; onClose: () => void; readOnly?: boolean }) {
  const { data: boxes = [], isLoading } = useAdminMailboxes();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  const change = async (mailboxId: string, v: Access) => {
    setBusy(mailboxId);
    try {
      if (v) await api.put(`admin/mailboxes/${mailboxId}/members/${user.id}`, { role: v });
      else await api.del(`admin/mailboxes/${mailboxId}/members/${user.id}`);
      await qc.invalidateQueries({ queryKey: ["admin-mailboxes"] });
      qc.invalidateQueries({ queryKey: ["admin-users"] });
      qc.invalidateQueries({ queryKey: ["mailboxes"] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Mailbox access"
      description={readOnly ? `Inboxes ${user.name || user.email} can open. Only admins can change this.` : `Choose which inboxes ${user.name || user.email} can open. They can switch between them or see them all in one view.`}
      width={600}
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}
    >
      {isLoading ? (
        <Spinner />
      ) : boxes.length === 0 ? (
        <EmptyState icon={<Inbox className="size-5" />} title="No mailboxes yet" body="Create one in Admin → Mailboxes." />
      ) : (
        <fieldset disabled={readOnly} className="min-w-0">
          <AccessList boxes={boxes} busy={busy} value={(id) => boxes.find((b) => b.id === id)?.members.find((m) => m.userId === user.id)?.role ?? ""} onChange={change} />
        </fieldset>
      )}
    </Modal>
  );
}
