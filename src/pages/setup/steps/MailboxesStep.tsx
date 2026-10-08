import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Inbox, Plus, Users, X } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { useDomainList, useRefreshSetup } from "@/lib/setup";
import { Badge, Button, Checkbox, cx, Input } from "@/components/ui/primitives";
import { Panel, StepFrame, type StepProps } from "../StepFrame";

const localOf = (email: string) => email.split("@")[0]?.toLowerCase().replace(/[^a-z0-9._-]/g, "") ?? "";
const validLocal = (v: string) => /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(v);

/** local@domain editor with a domain picker when there are several domains. */
function AddressInput({ local, setLocal, domain, setDomain, domains, label }: { local: string; setLocal: (v: string) => void; domain: string; setDomain: (v: string) => void; domains: string[]; label: string }) {
  return (
    <div className={cx("flex h-9 min-w-0 flex-1 items-stretch overflow-hidden rounded-ui border bg-surface focus-within:border-accent focus-within:ring-3 focus-within:ring-accent-soft", local && !validLocal(local) ? "border-danger" : "border-line")}>
      <input aria-label={label} value={local} onChange={(e) => setLocal(e.target.value.toLowerCase().replace(/\s/g, ""))} className="min-w-0 flex-1 bg-transparent px-3 text-sm outline-none" />
      {domains.length > 1 ? (
        <select aria-label="Domain" value={domain} onChange={(e) => setDomain(e.target.value)} className="border-l border-line bg-subtle px-2 text-sm text-fg-muted outline-none">
          {domains.map((d) => (
            <option key={d} value={d}>
              @{d}
            </option>
          ))}
        </select>
      ) : (
        <span className="flex items-center border-l border-line bg-subtle px-3 text-sm text-fg-muted">@{domain}</span>
      )}
    </div>
  );
}

interface SharedRow {
  key: string;
  on: boolean;
  local: string;
  name: string;
}

export function MailboxesStep({ setup, next, skip, back, goto }: StepProps) {
  const { data: list } = useDomainList();
  const domains = useMemo(() => (list?.domains ?? []).map((d) => d.name), [list]);
  const primary = setup.primaryDomain || domains[0] || "";
  const existing = new Set(setup.mailboxes.map((m) => m.address));
  const ownerLocal = setup.me.email.endsWith(`@${primary}`) ? localOf(setup.me.email) : localOf(setup.me.name.split(" ")[0] ?? "") || localOf(setup.me.email);
  const hasPersonal = setup.mailboxes.some((m) => m.type === "personal");

  const [personal, setPersonal] = useState({ on: !hasPersonal, local: ownerLocal, domain: primary });
  const [shared, setShared] = useState<SharedRow[]>(() =>
    setup.suggestedMailboxes.map((s, i) => ({ key: `s${i}`, on: !existing.has(`${s.local}@${primary}`), local: s.local, name: s.name })),
  );
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const refresh = useRefreshSetup();

  if (!primary) {
    return (
      <StepFrame title="Create mailboxes" description="Mailboxes live on your domain, so add one first." onBack={back} onSkip={skip}>
        <Button variant="primary" onClick={() => goto("domains")}>
          Add a domain
        </Button>
      </StepFrame>
    );
  }

  const chosenShared = shared.filter((s) => s.on && validLocal(s.local) && !existing.has(`${s.local}@${primary}`));
  const wantPersonal = personal.on && validLocal(personal.local);
  const nothing = !wantPersonal && !chosenShared.length;

  const create = async () => {
    if (nothing) return next();
    setBusy(true);
    try {
      const r = await api.post<{ created: { address: string }[]; skipped: { address: string; reason: string }[] }>("admin/setup/mailboxes", {
        ...(wantPersonal ? { personal: { address: `${personal.local}@${personal.domain}`, displayName: setup.me.name } } : {}),
        shared: chosenShared.map((s) => ({ address: `${s.local}@${primary}`, name: s.name || s.local })),
      });
      if (r.created.length) toast.success(`Created ${r.created.map((c) => c.address).join(", ")}`);
      for (const s of r.skipped) toast.warning(`${s.address}: ${s.reason}`);
      await Promise.all([qc.invalidateQueries({ queryKey: ["mailboxes"] }), refresh()]);
      next();
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <StepFrame
      title="Create mailboxes"
      description="Your own inbox, plus shared ones the team answers together. You can add more any time in Admin → Mailboxes."
      onBack={back}
      onSkip={setup.steps.mailboxes === "done" ? undefined : skip}
      onContinue={create}
      continueLoading={busy}
      continueLabel={nothing ? "Continue" : "Create and continue"}
    >
      {setup.mailboxes.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {setup.mailboxes.map((m) => (
            <Badge key={m.id} tone="success">
              {m.type === "shared" ? <Users className="size-3" /> : <Inbox className="size-3" />} {m.address}
            </Badge>
          ))}
        </div>
      )}

      {!hasPersonal && (
        <Panel title="Your inbox" description="Where mail to you personally arrives. You can also sign in with this address.">
          <div className="flex items-center gap-3">
            <Checkbox checked={personal.on} onChange={(v) => setPersonal((p) => ({ ...p, on: v }))} label="Create my inbox" />
            <AddressInput
              label="Your address"
              local={personal.local}
              setLocal={(v) => setPersonal((p) => ({ ...p, local: v }))}
              domain={personal.domain}
              setDomain={(v) => setPersonal((p) => ({ ...p, domain: v }))}
              domains={domains}
            />
          </div>
        </Panel>
      )}

      <Panel title="Shared inboxes" description="Suggested for how you'll use it. Everyone you give access can read and reply.">
        <ul className="space-y-2.5">
          {shared.map((s) => {
            const taken = existing.has(`${s.local}@${primary}`);
            return (
              <li key={s.key} className="flex items-center gap-3">
                <Checkbox checked={s.on && !taken} onChange={(v) => setShared((rows) => rows.map((r) => (r.key === s.key ? { ...r, on: v } : r)))} label={`Create ${s.local}@${primary}`} />
                <AddressInput label="Shared address" local={s.local} setLocal={(v) => setShared((rows) => rows.map((r) => (r.key === s.key ? { ...r, local: v, on: true } : r)))} domain={primary} setDomain={() => {}} domains={[primary]} />
                <Input aria-label="Name in the sidebar" value={s.name} onChange={(e) => setShared((rows) => rows.map((r) => (r.key === s.key ? { ...r, name: e.target.value } : r)))} className="w-32 max-sm:hidden" placeholder="Name" />
                {taken ? (
                  <Badge tone="success">Exists</Badge>
                ) : (
                  <button type="button" aria-label="Remove" onClick={() => setShared((rows) => rows.filter((r) => r.key !== s.key))} className="rounded p-1 text-fg-muted hover:bg-muted hover:text-fg">
                    <X className="size-4" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <Button size="sm" variant="ghost" className="mt-3" icon={<Plus className="size-4" />} onClick={() => setShared((rows) => [...rows, { key: `n${Date.now()}`, on: true, local: "", name: "" }])}>
          Add a shared inbox
        </Button>
      </Panel>
      {domains.length > 1 && <p className="text-xs text-fg-muted">Each mailbox also gets its address on {domains.filter((d) => d !== primary).join(", ")}.</p>}
    </StepFrame>
  );
}
