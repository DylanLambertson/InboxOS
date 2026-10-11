import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { mailDomains } from "@shared/brand";
import { api, errorMessage } from "@/lib/api";
import { useBrand } from "@/lib/brand";
import { Button, Field, Input, Select } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlay";

export function CreateMailboxDialog({ onClose, onCreated }: { onClose: () => void; onCreated?: (id: string) => void }) {
  const brand = useBrand();
  const qc = useQueryClient();
  const [local, setLocal] = useState("");
  const domains = mailDomains(brand);
  const [domain, setDomain] = useState(domains[0]);
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [type, setType] = useState<"shared" | "personal">("shared");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ id: string }>("admin/mailboxes", { address: `${local.trim()}@${domain.trim()}`, name, displayName, type });
      qc.invalidateQueries({ queryKey: ["admin-mailboxes"] });
      toast.success("Mailbox created — add members next");
      onClose();
      onCreated?.(r.id);
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
      title="New mailbox"
      description="Shared mailboxes (like hello@ or support@) can have many members. Mail is only received for domains set up in your email provider."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!local.trim()} onClick={submit}>
            Create mailbox
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Address">
          <div className="flex items-center gap-1.5">
            <Input value={local} onChange={(e) => setLocal(e.target.value.replace(/[@\s]/g, ""))} placeholder="support" autoFocus />
            <span className="text-fg-muted">@</span>
            {domains.length > 1 ? (
              <Select value={domain} onChange={(e) => setDomain(e.target.value)} className="w-auto">
                {domains.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </Select>
            ) : (
              <Input value={domain} onChange={(e) => setDomain(e.target.value.trim())} />
            )}
          </div>
          {domains.length > 1 && local.trim() && (
            <p className="mt-1.5 text-xs text-fg-muted">
              Also sends and receives as{" "}
              {domains
                .filter((d) => d !== domain)
                .map((d) => <span key={d} className="font-medium text-fg">{local.trim()}@{d}</span>)
                .reduce<ReactNode[]>((acc, el, i) => (i ? [...acc, ", ", el] : [el]), [])}
              .
            </p>
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Mailbox name" hint="Label in everyone's sidebar. Only your team sees it.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={local ? local.charAt(0).toUpperCase() + local.slice(1) : "Support"} />
          </Field>
          <Field label="Sender name" hint="What recipients see in the From line.">
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={`${brand.companyName} Support`} />
          </Field>
        </div>
        <Field label="Type">
          <Select value={type} onChange={(e) => setType(e.target.value as "shared" | "personal")}>
            <option value="shared">Shared — a team inbox</option>
            <option value="personal">Personal — one person's inbox</option>
          </Select>
        </Field>
      </div>
    </Modal>
  );
}
