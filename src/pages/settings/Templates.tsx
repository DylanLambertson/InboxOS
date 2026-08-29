import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FileText, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { Template } from "@shared/types";
import { api, errorMessage } from "@/lib/api";
import { useMe, useTemplates } from "@/lib/queries";
import { relativeTime } from "@/lib/format";
import { RichTextField } from "@/components/compose/Editor";
import { Badge, Button, Card, EmptyState, Field, IconButton, Input, PageHeader, Select } from "@/components/ui/primitives";
import { Modal, useConfirm } from "@/components/ui/overlay";

function TemplateEditor({ template, open, onClose, canShare }: { template?: Template; open: boolean; onClose: () => void; canShare: boolean }) {
  const qc = useQueryClient();
  const [name, setName] = useState(template?.name ?? "");
  const [subject, setSubject] = useState(template?.subject ?? "");
  const [html, setHtml] = useState(template?.html ?? "");
  const [scope, setScope] = useState<Template["scope"]>(template?.scope ?? "personal");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      if (template) await api.patch(`templates/${template.id}`, { name, subject, html, scope });
      else await api.post("templates", { name, subject, html, scope });
      qc.invalidateQueries({ queryKey: ["templates"] });
      toast.success("Template saved");
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={template ? "Edit template" : "New template"}
      width={720}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={save}>
            Save template
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Proposal follow-up" autoFocus />
          </Field>
          <Field label="Visibility">
            <Select value={scope} onChange={(e) => setScope(e.target.value as Template["scope"])} disabled={!canShare}>
              <option value="personal">Only me</option>
              <option value="org">Everyone</option>
            </Select>
          </Field>
        </div>
        <Field label="Subject" hint="Used when the message doesn't have a subject yet.">
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="Body">
          <RichTextField value={html} onChange={setHtml} minHeight={220} />
        </Field>
      </div>
    </Modal>
  );
}

export function TemplatesSettings() {
  const { data: templates = [] } = useTemplates();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<{ t?: Template; key: number } | null>(null);
  const isAdmin = me?.role === "owner" || me?.role === "admin";
  const canEdit = (t: Template) => (t.scope === "org" ? isAdmin : t.ownerId === me?.id);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Templates"
        description="Reusable messages you can insert from the compose window."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({ key: Date.now() })}>
            New template
          </Button>
        }
      />
      {templates.length === 0 ? (
        <Card>
          <EmptyState icon={<FileText className="size-5" />} title="No templates yet" body="Save time on messages you send often." />
        </Card>
      ) : (
        <Card className="divide-y divide-line">
          {templates.map((t) => (
            <div key={t.id} className="flex items-center gap-3 px-5 py-3.5">
              <FileText className="size-4 shrink-0 text-fg-muted" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">
                  {t.name} {t.scope === "org" && <Badge tone="accent" className="ml-1">Shared</Badge>}
                </p>
                <p className="truncate text-xs text-fg-muted">
                  {t.subject || "No subject"} · Updated {relativeTime(t.updatedAt)}
                </p>
              </div>
              {canEdit(t) && (
                <>
                  <IconButton label="Edit" onClick={() => setEditing({ t, key: Date.now() })}>
                    <Pencil className="size-4" />
                  </IconButton>
                  <IconButton
                    label="Delete"
                    onClick={async () => {
                      if (!(await confirm({ title: `Delete “${t.name}”?`, confirmLabel: "Delete", danger: true }))) return;
                      await api.del(`templates/${t.id}`);
                      qc.invalidateQueries({ queryKey: ["templates"] });
                    }}
                  >
                    <Trash2 className="size-4" />
                  </IconButton>
                </>
              )}
            </div>
          ))}
        </Card>
      )}
      {editing && <TemplateEditor key={editing.key} template={editing.t} open onClose={() => setEditing(null)} canShare={isAdmin} />}
    </div>
  );
}
