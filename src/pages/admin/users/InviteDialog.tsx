import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Copy } from "lucide-react";
import { toast } from "sonner";
import type { MailboxRole, Role } from "@shared/types";
import { api, errorMessage } from "@/lib/api";
import { useBrand } from "@/lib/brand";
import { useMe } from "@/lib/queries";
import { Button, Field, Input, Select, Switch } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlay";
import { AccessPicker } from "../MailboxAccess";

export const ROLE_HELP: Record<Role, string> = {
  owner: "Full control, including security settings and other owners.",
  admin: "Manage users, mailboxes, branding and logs.",
  manager: "View-only admin console: overview, all traffic, users, mailboxes and logs. Can't change anything.",
  member: "Use the mailboxes they're given access to.",
};

export function LinkResult({ url, emailed, kind }: { url: string; emailed: boolean; kind: "invite" | "reset" }) {
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

export function InviteDialog({ onClose }: { onClose: () => void }) {
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
              <option value="manager">Manager</option>
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
