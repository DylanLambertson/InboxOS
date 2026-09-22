import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Tag, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { Label, MailboxSummary } from "@shared/types";
import { api, errorMessage } from "@/lib/api";
import { mailboxLabel } from "@/lib/format";
import { useLabels, useMailboxes } from "@/lib/queries";
import { RichTextField } from "@/components/compose/Editor";
import { LabelDialog } from "@/components/mail/LabelDialog";
import { AutoReplySettings, BlockedSenders } from "./MailboxRules";
import { MailRulesSection } from "./MailRules";
import { Badge, Button, EmptyState, Field, IconButton, Input, PageHeader, Section } from "@/components/ui/primitives";
import { useConfirm } from "@/components/ui/overlay";

const ROLE_COPY = { owner: "Owner", editor: "Can send", viewer: "Read only" } as const;

function MailboxCard({ box }: { box: MailboxSummary }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [label, setLabel] = useState(box.name);
  const [name, setName] = useState(box.displayName);
  const [sig, setSig] = useState(box.signatureHtml);
  const [saving, setSaving] = useState(false);
  const [editLabel, setEditLabel] = useState<Label | undefined>();
  const [labelOpen, setLabelOpen] = useState(false);
  const { data: labels = [] } = useLabels(box.id);
  const isOwner = box.role === "owner";

  const save = async () => {
    setSaving(true);
    try {
      await api.patch(`mailboxes/${box.id}`, { name: label, displayName: name, signatureHtml: sig === "<p></p>" ? "" : sig });
      qc.invalidateQueries({ queryKey: ["mailboxes"] });
      toast.success("Mailbox updated");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section
      title={mailboxLabel(box)}
      description={
        <span className="flex flex-wrap items-center gap-2">
          {box.address}
          <Badge>{box.type === "shared" ? "Shared" : "Personal"}</Badge>
          <Badge tone="accent">{ROLE_COPY[box.role]}</Badge>
        </span>
      }
    >
      <div className="space-y-5">
        {box.aliases.length > 0 && (
          <Field label="Also receives mail for">
            <div className="flex flex-wrap gap-1.5">
              {box.aliases.map((a) => (
                <Badge key={a}>{a}</Badge>
              ))}
            </div>
          </Field>
        )}
        {isOwner ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Mailbox name" hint="How it's labeled in the sidebar. Only your team sees this.">
                <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Support" />
              </Field>
              <Field label="Sender name" hint="What recipients see in the From line.">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme Support" />
              </Field>
            </div>
            <Field label="Mailbox signature" hint="Used for everyone sending from this mailbox.">
              <RichTextField value={sig} onChange={setSig} minHeight={90} />
            </Field>
            <div className="flex justify-end">
              <Button variant="primary" loading={saving} onClick={save}>
                Save
              </Button>
            </div>
          </>
        ) : (
          <p className="text-[13px] text-fg-muted">Only mailbox owners can change the mailbox name, sender name and signature.</p>
        )}

        <div className="border-t border-line pt-5">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[13px] font-medium">Labels</p>
            {box.role !== "viewer" && (
              <Button size="sm" onClick={() => (setEditLabel(undefined), setLabelOpen(true))}>
                New label
              </Button>
            )}
          </div>
          {labels.length === 0 && <p className="text-xs text-fg-muted">No labels yet.</p>}
          <div className="divide-y divide-line">
            {labels.map((l) => (
              <div key={l.id} className="flex items-center gap-2 py-1.5">
                <Tag className="size-4" style={{ color: l.color }} />
                <span className="flex-1 text-[13px]">{l.name}</span>
                {box.role !== "viewer" && (
                  <>
                    <IconButton size="sm" label="Edit" onClick={() => (setEditLabel(l), setLabelOpen(true))}>
                      <Pencil className="size-3.5" />
                    </IconButton>
                    <IconButton
                      size="sm"
                      label="Delete"
                      onClick={async () => {
                        if (!(await confirm({ title: `Delete “${l.name}”?`, body: "Messages keep their other labels and stay where they are.", confirmLabel: "Delete", danger: true }))) return;
                        await api.del(`labels/${l.id}`);
                        qc.invalidateQueries({ queryKey: ["labels", box.id] });
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </IconButton>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>

        <MailRulesSection box={box} />
        <AutoReplySettings box={box} />
        <BlockedSenders box={box} />
      </div>
      <LabelDialog open={labelOpen} onClose={() => setLabelOpen(false)} mailboxId={box.id} label={editLabel} />
    </Section>
  );
}

export function MailboxSettings() {
  const { data: boxes = [] } = useMailboxes();
  return (
    <div className="space-y-6">
      <PageHeader title="Mailboxes" description="Mailboxes you have access to. Admins manage membership from the Admin console." />
      {boxes.length === 0 && <EmptyState title="No mailboxes" body="Ask an administrator to give you access." />}
      {boxes.map((b) => (
        <MailboxCard key={b.id} box={b} />
      ))}
    </div>
  );
}
