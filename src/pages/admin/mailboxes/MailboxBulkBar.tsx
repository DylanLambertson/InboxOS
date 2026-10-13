import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Power, PowerOff, Tags, Trash2, UserMinus, UserPlus, X } from "lucide-react";
import { ACCESS_NAME, BULK_CHUNK, type AdminUserRow, type MailboxBulkAction } from "@shared/admin";
import type { MailboxRole } from "@shared/types";
import { api } from "@/lib/api";
import { useFeature } from "@/lib/workspace";
import { Button, Field, IconButton, Select } from "@/components/ui/primitives";
import { Menu, Modal } from "@/components/ui/overlay";
import { BulkDialog, type BulkSpec, type BulkTargets } from "../table/BulkDialog";

const boxes = (n: number) => `${n.toLocaleString()} mailbox${n === 1 ? "" : "es"}`;

function spec(action: MailboxBulkAction, n: number, params: Record<string, unknown> = {}, person = ""): BulkSpec {
  const base = { endpoint: "admin/mailboxes/bulk", action, params, chunk: BULK_CHUNK, noun: "mailboxes" };
  switch (action) {
    case "add_member":
      return { ...base, title: `Give ${person} access to ${boxes(n)}`, description: `Access level: ${ACCESS_NAME[params.access as MailboxRole]}. Where they already have access, it changes to this level.`, confirmLabel: "Give access" };
    case "remove_member":
      return { ...base, title: `Remove ${person} from ${boxes(n)}`, description: "They lose access. The mail stays.", confirmLabel: "Remove access", danger: true };
    case "set_type":
      return { ...base, title: `Make ${boxes(n)} ${params.type}`, description: params.type === "shared" ? "Shared mailboxes are team inboxes several people answer." : "Personal mailboxes belong to one person.", confirmLabel: "Change type" };
    case "activate":
      return { ...base, title: `Activate ${boxes(n)}`, description: "They send and receive mail again.", confirmLabel: "Activate" };
    case "deactivate":
      return { ...base, title: `Deactivate ${boxes(n)}`, description: "They stop sending and receiving. Nothing is deleted.", confirmLabel: "Deactivate", danger: true };
    case "delete":
      return {
        ...base,
        title: `Delete ${boxes(n)}`,
        description: "Every message and attachment in them is deleted permanently. Mailboxes under legal hold are left alone. Large mailboxes take a little while.",
        confirmLabel: "Delete",
        danger: true,
        typeToConfirm: "delete",
      };
  }
}

/** Bulk actions for selected mailboxes: members, type, active state and deletion. */
export function MailboxBulkBar({ count, targets, onClear, onDone }: { count: number; targets: BulkTargets; onClear: () => void; onDone: () => void }) {
  const { data: users = [] } = useQuery({ queryKey: ["admin-users"], queryFn: () => api.get<AdminUserRow[]>("admin/users") });
  const [ask, setAsk] = useState<null | "add_member" | "remove_member" | "set_type">(null);
  const [userId, setUserId] = useState("");
  const [access, setAccess] = useState<MailboxRole>("editor");
  const sharedOn = useFeature("sharedInboxes");
  const [type, setType] = useState<"shared" | "personal">(sharedOn ? "shared" : "personal");
  const [running, setRunning] = useState<BulkSpec | null>(null);
  const person = users.find((u) => u.id === userId);

  const confirmParams = () => {
    if (ask === "set_type") setRunning(spec("set_type", count, { type }));
    if (ask === "add_member" && person) setRunning(spec("add_member", count, { userId, access }, person.name || person.email));
    if (ask === "remove_member" && person) setRunning(spec("remove_member", count, { userId }, person.name || person.email));
    setAsk(null);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-ui border border-accent/30 bg-accent-softer px-3 py-2" role="toolbar" aria-label="Bulk actions">
      <span className="text-[13px] font-medium">{boxes(count)} selected</span>
      <IconButton size="sm" label="Clear selection" onClick={onClear}>
        <X className="size-4" />
      </IconButton>
      <div className="ml-auto flex flex-wrap gap-2">
        <Button size="sm" icon={<UserPlus className="size-4" />} onClick={() => setAsk("add_member")}>Add person</Button>
        <Button size="sm" icon={<UserMinus className="size-4" />} onClick={() => setAsk("remove_member")}>Remove person</Button>
        <Menu
          align="end"
          width={220}
          items={[
            { label: "Change type…", icon: <Tags />, onSelect: () => setAsk("set_type") },
            { label: "Activate", icon: <Power />, onSelect: () => setRunning(spec("activate", count)) },
            { label: "Deactivate", icon: <PowerOff />, onSelect: () => setRunning(spec("deactivate", count)) },
            { separator: true, label: "" },
            { label: "Delete…", icon: <Trash2 />, danger: true, onSelect: () => setRunning(spec("delete", count)) },
          ]}
          trigger={(p) => (
            <Button size="sm" {...p}>
              More <ChevronDown className="size-3.5" />
            </Button>
          )}
        />
      </div>
      <Modal
        open={!!ask}
        onClose={() => setAsk(null)}
        title={ask === "set_type" ? "Change type" : ask === "add_member" ? "Add a person" : "Remove a person"}
        description={`For ${boxes(count)}. You'll see exactly what changes before anything is saved.`}
        footer={
          <>
            <Button onClick={() => setAsk(null)}>Cancel</Button>
            <Button variant="primary" disabled={ask !== "set_type" && !person} onClick={confirmParams}>Continue</Button>
          </>
        }
      >
        {ask === "set_type" ? (
          <Field label="Type">
            <Select value={type} onChange={(e) => setType(e.target.value as "shared" | "personal")}>
              {sharedOn && <option value="shared">Shared: a team inbox</option>}
              <option value="personal">Personal: one person's inbox</option>
            </Select>
          </Field>
        ) : (
          <div className="space-y-4">
            <Field label="Person">
              <Select value={userId} onChange={(e) => setUserId(e.target.value)} autoFocus>
                <option value="">Choose someone…</option>
                {users.filter((u) => u.status !== "disabled" || ask === "remove_member").map((u) => (
                  <option key={u.id} value={u.id}>{u.name ? `${u.name} (${u.email})` : u.email}</option>
                ))}
              </Select>
            </Field>
            {ask === "add_member" && (
              <Field label="Access">
                <Select value={access} onChange={(e) => setAccess(e.target.value as MailboxRole)}>
                  <option value="viewer">{ACCESS_NAME.viewer}</option>
                  <option value="editor">{ACCESS_NAME.editor}</option>
                  <option value="owner">{ACCESS_NAME.owner}</option>
                </Select>
              </Field>
            )}
          </div>
        )}
      </Modal>
      {running && <BulkDialog spec={running} targets={targets} onClose={() => setRunning(null)} onDone={onDone} />}
    </div>
  );
}
