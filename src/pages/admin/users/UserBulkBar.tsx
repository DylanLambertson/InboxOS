import { useState } from "react";
import { ChevronDown, Inbox, LogOut, MailPlus, ShieldOff, Trash2, UserCheck, UserCog, UserX, X } from "lucide-react";
import { ACCESS_NAME, BULK_CHUNK, BULK_EMAIL_CHUNK, type UserBulkAction } from "@shared/admin";
import type { MailboxRole, Role } from "@shared/types";
import { mailboxLabel } from "@/lib/format";
import { useMe } from "@/lib/queries";
import { Button, Field, IconButton, Select } from "@/components/ui/primitives";
import { Menu, Modal } from "@/components/ui/overlay";
import { BulkDialog, type BulkSpec, type BulkTargets } from "../table/BulkDialog";
import { useAdminMailboxes } from "../MailboxAccess";
import { ROLE_HELP } from "./InviteDialog";

const people = (n: number) => `${n.toLocaleString()} ${n === 1 ? "person" : "people"}`;

function spec(action: UserBulkAction, n: number, params: Record<string, unknown> = {}, mailbox = ""): BulkSpec {
  const base = { endpoint: "admin/users/bulk", action, params, chunk: action === "resend_invite" ? BULK_EMAIL_CHUNK : BULK_CHUNK, noun: "people" };
  switch (action) {
    case "role":
      return { ...base, title: `Change role for ${people(n)}`, description: ROLE_HELP[params.role as Role], confirmLabel: "Change role" };
    case "disable":
      return { ...base, title: `Disable ${people(n)}`, description: "They're signed out right away and can't sign in. Mailboxes and mail are kept.", confirmLabel: "Disable", danger: true };
    case "enable":
      return { ...base, title: `Enable ${people(n)}`, description: "They can sign in again. People who never accepted their invite stay invited.", confirmLabel: "Enable" };
    case "resend_invite":
      return { ...base, title: `Resend invites to ${people(n)}`, description: "Each gets a fresh link by email; older links stop working.", confirmLabel: "Resend invites" };
    case "reset_2fa":
      return { ...base, title: `Reset two-factor for ${people(n)}`, description: "Their authenticator app is removed and they're signed out. Passkeys are kept.", confirmLabel: "Reset 2FA", danger: true };
    case "sign_out":
      return { ...base, title: `Sign out ${people(n)}`, description: "Every session on every device ends. They can sign in again right away.", confirmLabel: "Sign out" };
    case "add_mailbox":
      return { ...base, title: `Give ${people(n)} access to ${mailbox}`, description: `Access level: ${ACCESS_NAME[params.access as MailboxRole]}. People who already have access get this level.`, confirmLabel: "Give access" };
    case "remove_mailbox":
      return { ...base, title: `Remove ${people(n)} from ${mailbox}`, description: "They lose access to the mailbox. Its mail is kept.", confirmLabel: "Remove access", danger: true };
    case "delete":
      return { ...base, title: `Delete ${people(n)}`, description: "Accounts are removed permanently. Their mailboxes and mail are kept.", confirmLabel: "Delete", danger: true, typeToConfirm: "delete" };
  }
}

/** The bar shown while rows are selected: pick a bulk action, its options, then review and run it. */
export function UserBulkBar({ count, targets, onClear, onDone }: { count: number; targets: BulkTargets; onClear: () => void; onDone: () => void }) {
  const { data: me } = useMe();
  const { data: boxes = [] } = useAdminMailboxes();
  const [ask, setAsk] = useState<null | "role" | "add_mailbox" | "remove_mailbox">(null);
  const [role, setRole] = useState<Role>("member");
  const [mailboxId, setMailboxId] = useState("");
  const [access, setAccess] = useState<MailboxRole>("editor");
  const [running, setRunning] = useState<BulkSpec | null>(null);
  const mailbox = boxes.find((b) => b.id === mailboxId);

  const start = (action: UserBulkAction) => setRunning(spec(action, count));
  const confirmParams = () => {
    if (ask === "role") setRunning(spec("role", count, { role }));
    if (ask === "add_mailbox" && mailbox) setRunning(spec("add_mailbox", count, { mailboxId, access }, mailbox.address));
    if (ask === "remove_mailbox" && mailbox) setRunning(spec("remove_mailbox", count, { mailboxId }, mailbox.address));
    setAsk(null);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-ui border border-accent-ink/30 bg-accent-softer px-3 py-2" role="toolbar" aria-label="Bulk actions">
      <span className="text-[13px] font-medium">{people(count)} selected</span>
      <IconButton size="sm" label="Clear selection" onClick={onClear}>
        <X className="size-4" />
      </IconButton>
      <div className="ml-auto flex flex-wrap gap-2">
        <Button size="sm" icon={<UserCog className="size-4" />} onClick={() => setAsk("role")}>Change role</Button>
        <Button size="sm" icon={<Inbox className="size-4" />} onClick={() => setAsk("add_mailbox")}>Add to mailbox</Button>
        <Menu
          align="end"
          width={230}
          items={[
            { label: "Remove from mailbox…", icon: <Inbox />, onSelect: () => setAsk("remove_mailbox") },
            { label: "Resend invite", icon: <MailPlus />, onSelect: () => start("resend_invite") },
            { label: "Reset two-factor", icon: <ShieldOff />, onSelect: () => start("reset_2fa") },
            { label: "Sign out everywhere", icon: <LogOut />, onSelect: () => start("sign_out") },
            { separator: true, label: "" },
            { label: "Enable", icon: <UserCheck />, onSelect: () => start("enable") },
            { label: "Disable", icon: <UserX />, onSelect: () => start("disable") },
            { label: "Delete…", icon: <Trash2 />, danger: true, onSelect: () => start("delete") },
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
        title={ask === "role" ? "Change role" : ask === "add_mailbox" ? "Add to a mailbox" : "Remove from a mailbox"}
        description={`For ${people(count)}. You'll see exactly what changes before anything is saved.`}
        footer={
          <>
            <Button onClick={() => setAsk(null)}>Cancel</Button>
            <Button variant="primary" disabled={ask !== "role" && !mailbox} onClick={confirmParams}>Continue</Button>
          </>
        }
      >
        {ask === "role" ? (
          <Field label="New role" hint={ROLE_HELP[role]}>
            <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="member">Member</option>
              <option value="manager">Manager</option>
              <option value="admin">Admin</option>
              {me?.role === "owner" && <option value="owner">Owner</option>}
            </Select>
          </Field>
        ) : (
          <div className="space-y-4">
            <Field label="Mailbox">
              <Select value={mailboxId} onChange={(e) => setMailboxId(e.target.value)} autoFocus>
                <option value="">Choose a mailbox…</option>
                {boxes.map((b) => (
                  <option key={b.id} value={b.id}>{mailboxLabel(b)} ({b.address})</option>
                ))}
              </Select>
            </Field>
            {ask === "add_mailbox" && (
              <Field label="Access" hint="Read only can read and organize. Can send can also reply. Owner can also change the sender name and signature.">
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
