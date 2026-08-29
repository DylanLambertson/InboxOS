import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, Pencil, Plus, Search, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import type { Contact } from "@shared/types";
import { api, errorMessage } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { useMailboxes } from "@/lib/queries";
import { useCompose } from "@/components/compose/ComposeProvider";
import { Avatar, Button, Card, EmptyState, Field, IconButton, Input, PageHeader, Textarea } from "@/components/ui/primitives";
import { Modal, Tabs, useConfirm } from "@/components/ui/overlay";

function ContactDialog({ contact, onClose }: { contact?: Contact; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ email: contact?.email ?? "", name: contact?.name ?? "", company: contact?.company ?? "", notes: contact?.notes ?? "" });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async () => {
    setBusy(true);
    try {
      if (contact) await api.patch(`contacts/${contact.id}`, form);
      else await api.post("contacts", form);
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["contacts-page"] });
      toast.success("Contact saved");
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
      title={contact ? "Edit contact" : "New contact"}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!form.email} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Email">
          <Input type="email" value={form.email} onChange={set("email")} autoFocus />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input value={form.name} onChange={set("name")} />
          </Field>
          <Field label="Company">
            <Input value={form.company} onChange={set("company")} />
          </Field>
        </div>
        <Field label="Notes">
          <Textarea value={form.notes} onChange={set("notes")} rows={3} />
        </Field>
      </div>
    </Modal>
  );
}

export function ContactsSettings() {
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"saved" | "all">("saved");
  const [editing, setEditing] = useState<{ c?: Contact } | null>(null);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const compose = useCompose();
  const { data: boxes = [] } = useMailboxes();
  const sendBox = boxes.find((b) => b.role !== "viewer");
  const { data: contacts = [], isLoading } = useQuery({
    queryKey: ["contacts-page", q, tab],
    queryFn: () => api.get<Contact[]>(`contacts?q=${encodeURIComponent(q)}&limit=200${tab === "saved" ? "&saved=1" : ""}`),
    placeholderData: (p) => p,
  });
  const rows = contacts.filter((c) => !c.id.startsWith("internal:"));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Contacts"
        description="Your organization's shared address book. People you email are collected automatically."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({})}>
            New contact
          </Button>
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={tab} onChange={setTab} tabs={[{ value: "saved", label: "Saved" }, { value: "all", label: "All" }]} />
        <div className="relative min-w-60 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-faint" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, email or company" className="pl-8" />
        </div>
      </div>
      <Card className="divide-y divide-line">
        {!isLoading && rows.length === 0 && <EmptyState icon={<Users className="size-5" />} title="No contacts" body={tab === "saved" ? "Save contacts to keep notes and details." : "People you email will appear here."} />}
        {rows.map((c) => (
          <div key={c.id} className="flex items-center gap-3 px-5 py-3">
            <Avatar email={c.email} name={c.name} size={32} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium">{c.name || c.email}</p>
              <p className="truncate text-xs text-fg-muted">
                {c.email}
                {c.company && ` · ${c.company}`}
                {c.lastContactedAt && ` · Last emailed ${relativeTime(c.lastContactedAt)}`}
              </p>
            </div>
            {sendBox && (
              <IconButton label="Email" onClick={() => compose.open({ mailboxId: sendBox.id, to: [{ email: c.email, name: c.name || undefined }] })}>
                <Mail className="size-4" />
              </IconButton>
            )}
            <IconButton label="Edit" onClick={() => setEditing({ c })}>
              <Pencil className="size-4" />
            </IconButton>
            <IconButton
              label="Delete"
              onClick={async () => {
                if (!(await confirm({ title: `Delete ${c.name || c.email}?`, confirmLabel: "Delete", danger: true }))) return;
                await api.del(`contacts/${c.id}`);
                qc.invalidateQueries({ queryKey: ["contacts-page"] });
              }}
            >
              <Trash2 className="size-4" />
            </IconButton>
          </div>
        ))}
      </Card>
      {editing && <ContactDialog contact={editing.c} onClose={() => setEditing(null)} />}
    </div>
  );
}
