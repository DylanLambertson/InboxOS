import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BellOff, FingerprintPattern, Inbox, KeyRound, Lock, LogOut, MailPlus, ShieldOff, Trash2, UserCheck, UserX } from "lucide-react";
import { toast } from "sonner";
import type { AdminUserRow } from "@shared/admin";
import { api, errorMessage } from "@/lib/api";
import { useCanManage, useMe } from "@/lib/queries";
import { Button } from "@/components/ui/primitives";
import { Modal, useConfirm, type MenuItem } from "@/components/ui/overlay";
import { LinkResult } from "./InviteDialog";

/** The single-person actions, shared by the table's row menu and the detail panel. */
export function useUserActions({ onAccess, onDeleted }: { onAccess: (u: AdminUserRow) => void; onDeleted?: () => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: me } = useMe();
  const editable = useCanManage();
  const [link, setLink] = useState<{ url: string; emailed: boolean; kind: "invite" | "reset" } | null>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["admin-users"] });
    qc.invalidateQueries({ queryKey: ["admin-sessions"] });
  };
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast.success(msg);
      refresh();
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    }
  };
  const canManage = (u: AdminUserRow) => editable && (me?.role === "owner" || u.role !== "owner");
  const who = (u: AdminUserRow) => u.name || u.email;

  const items = (u: AdminUserRow): MenuItem[] => {
    const self = u.id === me?.id;
    return [
      { label: "Manage mailbox access", icon: <Inbox />, onSelect: () => onAccess(u) },
      { separator: true, label: "" },
      ...(u.status === "invited"
        ? [{
            label: "Resend invite",
            icon: <MailPlus />,
            onSelect: () =>
              void api
                .post<{ inviteUrl: string; emailed: boolean }>(`admin/users/${u.id}/invite`, { sendEmail: true })
                .then((r) => setLink({ url: r.inviteUrl, emailed: r.emailed, kind: "invite" }))
                .catch((e) => toast.error(errorMessage(e))),
          }]
        : []),
      ...(u.status === "active"
        ? [{
            label: "Send password reset",
            icon: <KeyRound />,
            onSelect: () =>
              void api
                .post<{ resetUrl: string; emailed: boolean }>(`admin/users/${u.id}/reset-password`)
                .then((r) => setLink({ url: r.resetUrl, emailed: r.emailed, kind: "reset" }))
                .catch((e) => toast.error(errorMessage(e))),
          }]
        : []),
      ...(u.totpEnabled
        ? [{
            label: "Reset two-factor",
            icon: <ShieldOff />,
            onSelect: async () => {
              if (await confirm({ title: `Reset 2FA for ${who(u)}?`, body: "They'll be signed out and can sign in with just their password until they set it up again.", confirmLabel: "Reset 2FA", danger: true }))
                act(() => api.post(`admin/users/${u.id}/reset-2fa`), "Two-factor reset");
            },
          }]
        : []),
      ...(u.passkeyCount > 0
        ? [{
            label: "Remove passkeys",
            icon: <FingerprintPattern />,
            onSelect: async () => {
              if (await confirm({ title: `Remove ${who(u)}'s passkeys?`, body: `For a lost or stolen device. All ${u.passkeyCount} passkey${u.passkeyCount === 1 ? "" : "s"} will stop working and they'll be signed out everywhere. They can add new ones after signing in.`, confirmLabel: "Remove passkeys", danger: true }))
                act(() => api.post(`admin/users/${u.id}/remove-passkeys`), "Passkeys removed");
            },
          }]
        : []),
      ...(u.lockedUntil ? [{ label: "Unlock account", icon: <Lock />, onSelect: () => void act(() => api.patch(`admin/users/${u.id}`, { unlock: true }), "Account unlocked") }] : []),
      ...(u.digest ? [{ label: `Stop reminders to ${u.digest.to}`, icon: <BellOff />, onSelect: () => void act(() => api.post(`admin/users/${u.id}/digest-off`), "Reminders turned off") }] : []),
      { label: "Sign out everywhere", icon: <LogOut />, onSelect: () => void act(() => api.post(`admin/users/${u.id}/sign-out`), "Signed out of all sessions") },
      { separator: true, label: "" },
      u.status === "disabled"
        ? { label: "Enable account", icon: <UserCheck />, onSelect: () => void act(() => api.patch(`admin/users/${u.id}`, { status: "active" }), "Account enabled") }
        : {
            label: "Disable account",
            icon: <UserX />,
            disabled: self,
            onSelect: async () => {
              if (await confirm({ title: `Disable ${who(u)}?`, body: "They'll be signed out immediately and can't sign in. Their mailboxes are kept.", confirmLabel: "Disable", danger: true }))
                act(() => api.patch(`admin/users/${u.id}`, { status: "disabled" }), "Account disabled");
            },
          },
      {
        label: "Delete user",
        icon: <Trash2 />,
        danger: true,
        disabled: self,
        onSelect: async () => {
          if (await confirm({ title: `Delete ${who(u)}?`, body: "Their account is removed permanently. Mailboxes and messages are kept.", confirmLabel: "Delete user", danger: true, typeToConfirm: u.email }))
            if (await act(() => api.del(`admin/users/${u.id}`), "User deleted")) onDeleted?.();
        },
      },
    ];
  };

  const changeRole = (u: AdminUserRow, role: string) => act(() => api.patch(`admin/users/${u.id}`, { role }), "Role updated");

  const linkModal = (
    <Modal open={!!link} onClose={() => setLink(null)} title={link?.kind === "invite" ? "Invite link" : "Password reset link"} footer={<Button variant="primary" onClick={() => setLink(null)}>Done</Button>}>
      {link && <LinkResult url={link.url} emailed={link.emailed} kind={link.kind} />}
    </Modal>
  );
  return { items, canManage, changeRole, linkModal, me };
}
