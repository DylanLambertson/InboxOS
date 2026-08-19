import { Archive, ArchiveRestore, Inbox, MailOpen, Mail, ShieldAlert, ShieldCheck, Tag, Trash2, Undo2, XCircle } from "lucide-react";
import type { Folder, Label } from "@shared/types";
import { IconButton } from "../ui/primitives";
import { Menu, useConfirm } from "../ui/overlay";
import type { BulkInput } from "@/lib/queries";

/** Folder-aware action buttons shared by the list toolbar and the reader toolbar. */
export function BulkActions({
  folder,
  anyUnread,
  labels,
  readOnly,
  run,
  size = "md",
}: {
  folder: Folder | "starred" | "all" | "unread" | "label";
  anyUnread: boolean;
  labels: Label[];
  readOnly: boolean;
  run: (a: Omit<BulkInput, "ids">) => void;
  size?: "sm" | "md";
}) {
  const confirm = useConfirm();
  const icon = "size-4";
  const inTrash = folder === "trash";
  const inSpam = folder === "spam";
  const isDraftish = folder === "drafts" || folder === "scheduled";

  return (
    <div className="flex items-center gap-0.5">
      {!readOnly && !isDraftish && (
        <>
          {inTrash ? (
            <IconButton size={size} label="Restore" onClick={() => run({ action: "restore" })}>
              <Undo2 className={icon} />
            </IconButton>
          ) : folder === "archive" || inSpam ? (
            <IconButton size={size} label={inSpam ? "Not spam" : "Move to inbox"} onClick={() => run({ action: "move", folder: "inbox" })}>
              {inSpam ? <ShieldCheck className={icon} /> : <Inbox className={icon} />}
            </IconButton>
          ) : (
            <IconButton size={size} label="Archive" shortcut="E" onClick={() => run({ action: "move", folder: "archive" })}>
              <Archive className={icon} />
            </IconButton>
          )}
          {!inSpam && !inTrash && (
            <IconButton size={size} label="Report spam" shortcut="!" onClick={() => run({ action: "move", folder: "spam" })}>
              <ShieldAlert className={icon} />
            </IconButton>
          )}
          {inTrash || inSpam ? (
            <IconButton
              size={size}
              label="Delete forever"
              onClick={async () => {
                if (await confirm({ title: "Delete forever?", body: "These messages will be permanently deleted. This can't be undone.", confirmLabel: "Delete forever", danger: true }))
                  run({ action: "delete" });
              }}
            >
              <XCircle className={icon} />
            </IconButton>
          ) : (
            <IconButton size={size} label="Delete" shortcut="#" onClick={() => run({ action: "move", folder: "trash" })}>
              <Trash2 className={icon} />
            </IconButton>
          )}
        </>
      )}
      {isDraftish && !readOnly && folder === "drafts" && (
        <IconButton
          size={size}
          label="Discard drafts"
          onClick={async () => {
            if (await confirm({ title: "Discard drafts?", body: "Selected drafts will be permanently deleted.", confirmLabel: "Discard", danger: true })) run({ action: "delete" });
          }}
        >
          <Trash2 className={icon} />
        </IconButton>
      )}
      <IconButton
        size={size}
        label={anyUnread ? "Mark as read" : "Mark as unread"}
        shortcut={anyUnread ? "⇧I" : "⇧U"}
        onClick={() => run({ action: anyUnread ? "read" : "unread" })}
      >
        {anyUnread ? <MailOpen className={icon} /> : <Mail className={icon} />}
      </IconButton>
      {!readOnly && !isDraftish && labels.length > 0 && (
        <Menu
          width={220}
          items={[
            ...labels.map((l) => ({
              label: l.name,
              icon: <Tag style={{ color: l.color }} />,
              onSelect: () => run({ action: "labelAdd", labelId: l.id }),
            })),
            { separator: true, label: "" },
            ...labels.map((l) => ({ label: `Remove "${l.name}"`, icon: <Tag className="opacity-40" />, onSelect: () => run({ action: "labelRemove", labelId: l.id }) })),
          ]}
          trigger={(p) => (
            <IconButton size={size} label="Label" shortcut="L" {...p}>
              <Tag className={icon} />
            </IconButton>
          )}
        />
      )}
      {!readOnly && (folder === "inbox" || folder === "all" || folder === "starred" || folder === "label" || folder === "unread") && (
        <Menu
          items={[
            { label: "Archive", icon: <Archive />, onSelect: () => run({ action: "move", folder: "archive" }) },
            { label: "Inbox", icon: <ArchiveRestore />, onSelect: () => run({ action: "move", folder: "inbox" }) },
            { label: "Spam", icon: <ShieldAlert />, onSelect: () => run({ action: "move", folder: "spam" }) },
            { label: "Trash", icon: <Trash2 />, onSelect: () => run({ action: "move", folder: "trash" }) },
          ]}
          trigger={(p) => (
            <IconButton size={size} label="Move to" {...p}>
              <ArchiveRestore className={icon} />
            </IconButton>
          )}
        />
      )}
    </div>
  );
}
