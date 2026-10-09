import { useState } from "react";
import { Link } from "react-router";
import { ChevronDown, Globe, MoreHorizontal, Plus, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { useCanManage } from "@/lib/queries";
import { useDomainList, useRefreshSetup, type DomainList, type DomainListItem } from "@/lib/setup";
import { AddDomainForm } from "@/components/setup/AddDomainForm";
import { DomainSetupPanel } from "@/components/setup/DomainSetupPanel";
import { DomainStatusBadge } from "@/components/setup/StatusBadges";
import { Menu, Modal } from "@/components/ui/overlay";
import { Badge, Button, Checkbox, cx, EmptyState, IconButton, LoadError, PageHeader, Section, Spinner } from "@/components/ui/primitives";

function RemoveDomainModal({ domain, onClose }: { domain: DomainListItem | null; onClose: () => void }) {
  const [alsoProvider, setAlsoProvider] = useState(false);
  const [busy, setBusy] = useState(false);
  const refresh = useRefreshSetup();
  if (!domain) return null;
  const remove = async () => {
    setBusy(true);
    try {
      await api.del<DomainList>(`admin/domains/${encodeURIComponent(domain.name)}${alsoProvider ? "?provider=1" : ""}`);
      toast.success(`${domain.name} removed`);
      await refresh();
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`Stop using ${domain.name}?`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={busy} onClick={remove}>
            Remove
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[13px] text-fg-muted">
        <p>New mailboxes won't get addresses on this domain any more. Existing mailboxes and aliases at {domain.name} aren't deleted; remove them in Mailboxes if you no longer need them.</p>
        {domain.provider && (
          <label className="flex items-start gap-2">
            <Checkbox checked={alsoProvider} onChange={setAlsoProvider} label="Also delete it from Resend" className="mt-0.5" />
            <span>Also delete it from Resend. Mail to and from {domain.name} stops completely.</span>
          </label>
        )}
      </div>
    </Modal>
  );
}

function DomainRow({ d, open, onToggle, onRemove, canManage }: { d: DomainListItem; open: boolean; onToggle: () => void; onRemove: () => void; canManage: boolean }) {
  const refresh = useRefreshSetup();
  const makePrimary = async () => {
    try {
      await api.post(`admin/domains/${encodeURIComponent(d.name)}/primary`);
      toast.success(`${d.name} is now the primary domain`);
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <li className="overflow-hidden rounded-ui-lg border border-line bg-surface shadow-ui-sm">
      <div className="flex items-center gap-3 px-4 py-3">
        <button type="button" aria-expanded={open} onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <Globe className="size-4 shrink-0 text-fg-faint" />
          <span className="min-w-0 truncate text-sm font-semibold text-fg">{d.name}</span>
          {d.primary && <Badge tone="accent">Primary</Badge>}
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {d.provider && <span className="text-xs text-fg-faint max-sm:hidden">{d.provider.region}{d.provider.receiving === false ? " · sending only" : ""}</span>}
            <DomainStatusBadge status={d.provider?.status} />
            <ChevronDown className={cx("size-4 text-fg-muted transition-transform", open && "rotate-180")} />
          </span>
        </button>
        {canManage && (
          <Menu
            align="end"
            trigger={(p) => (
              <IconButton label={`Actions for ${d.name}`} size="sm" {...p}>
                <MoreHorizontal className="size-4" />
              </IconButton>
            )}
            items={[
              { label: "Make primary", icon: <Star className="size-4" />, onSelect: makePrimary, disabled: d.primary },
              { label: "Remove", icon: <Trash2 className="size-4" />, onSelect: onRemove, danger: true },
            ]}
          />
        )}
      </div>
      {open && (
        <div className="animate-in border-t border-line px-4 py-4">
          <DomainSetupPanel name={d.name} />
        </div>
      )}
    </li>
  );
}

/** Admin → Domains: every mail domain with its status, records and DNS health. */
export function AdminDomains() {
  const { data, error, isLoading, refetch } = useDomainList();
  const canManage = useCanManage();
  const refresh = useRefreshSetup();
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<DomainListItem | null>(null);

  if (isLoading) return <Spinner className="mx-auto mt-16 size-5" />;
  if (error || !data) return <LoadError error={error} onRetry={() => refetch()} />;

  const adopt = async (name: string) => {
    try {
      await api.post("admin/domains", { name });
      toast.success(`${name} is now used here`);
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Domains"
        description="The domains your addresses use, their status in Resend and their DNS records."
        actions={
          canManage && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
              Add domain
            </Button>
          )
        }
      />

      {!data.keyConfigured && (
        <div className="rounded-ui-lg border border-warning/30 bg-warning-soft px-4 py-3 text-[13px] text-warning">
          The email provider isn't connected, so domain status and DNS records can't be shown.{" "}
          <Link to="/admin/setup" className="font-medium underline">
            Connect Resend
          </Link>
        </div>
      )}
      {data.error && <div className="rounded-ui-lg border border-warning/30 bg-warning-soft px-4 py-3 text-[13px] text-warning">{data.error}</div>}

      {data.domains.length === 0 ? (
        <Section title="No domains yet">
          <EmptyState
            icon={<Globe className="size-5" />}
            title="Add your first domain"
            body="Mailboxes, sending and receiving all need a domain, like example.com."
            action={canManage && <Button variant="primary" onClick={() => setAdding(true)}>Add domain</Button>}
          />
        </Section>
      ) : (
        <ul className="space-y-3">
          {data.domains.map((d) => (
            <DomainRow key={d.name} d={d} canManage={canManage} open={open === d.name} onToggle={() => setOpen(open === d.name ? null : d.name)} onRemove={() => setRemoving(d)} />
          ))}
        </ul>
      )}

      <Section title="How domains work">
        <ul className="list-disc space-y-1.5 pl-5 text-[13px] text-fg-muted">
          <li>
            The <b className="text-fg">primary</b> domain is used for new mailboxes and for system emails (invitations, password resets), which come from no-reply@
            {data.primaryDomain || "your primary domain"}.
          </li>
          <li>
            Every mailbox gets its address on <b className="text-fg">each</b> domain: hello@ on one domain also receives at, and can send as, hello@ on the others. Addresses already taken
            by another mailbox are left alone.
          </li>
          <li>Mail to an address with no mailbox lands in Admin → All traffic → Unrouted, or in the catch-all mailbox if you set one.</li>
        </ul>
      </Section>

      {canManage && data.otherProviderDomains.length > 0 && (
        <Section title="Also in your Resend account" description="Domains you could use here too.">
          <ul className="divide-y divide-line">
            {data.otherProviderDomains.map((d) => (
              <li key={d.name} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{d.name}</span>
                <DomainStatusBadge status={d.status} />
                <Button size="xs" onClick={() => adopt(d.name)}>
                  Use here
                </Button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Modal open={adding} onClose={() => setAdding(false)} title="Add a domain" description="Already use it for email elsewhere? Use a subdomain such as inbox.example.com instead." width={560}>
        <AddDomainForm
          hasPrimary={!!data.primaryDomain}
          providerConnected={data.keyConfigured}
          onAdded={(n) => {
            setAdding(false);
            setOpen(n);
          }}
        />
      </Modal>
      <RemoveDomainModal key={removing?.name ?? ""} domain={removing} onClose={() => setRemoving(null)} />
    </div>
  );
}
