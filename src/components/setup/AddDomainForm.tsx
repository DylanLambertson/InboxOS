import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Plus } from "lucide-react";
import { toast } from "sonner";
import type { MxHost } from "@shared/dns";
import { DOMAIN_RE } from "@shared/setup";
import { api, errorMessage } from "@/lib/api";
import { useRefreshSetup, type DomainDetail } from "@/lib/setup";
import { Button, Checkbox, Field, Input } from "@/components/ui/primitives";
import { ConnectOptions } from "./DomainSetupPanel";

const clean = (v: string) =>
  v
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^[^@]*@/, "")
    .replace(/\/.*$/, "");

/**
 * Add a mail domain: checks first whether it already receives mail somewhere else
 * (Google Workspace, Microsoft 365…) and suggests a subdomain if so.
 */
export function AddDomainForm({ hasPrimary, providerConnected, onAdded }: { hasPrimary: boolean; providerConnected: boolean; onAdded?: (name: string) => void }) {
  const [name, setName] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [receiving, setReceiving] = useState(true);
  const [primary, setPrimary] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mx, setMx] = useState<{ name: string; existingMx: MxHost[]; mxWarning: string | null } | null>(null);
  const qc = useQueryClient();
  const refresh = useRefreshSetup();
  const domain = clean(name);
  const valid = DOMAIN_RE.test(domain);

  // Look for existing mail service a moment after typing stops.
  useEffect(() => {
    if (!valid) return setMx(null);
    const t = setTimeout(() => {
      api
        .get<{ name: string; existingMx: MxHost[]; mxWarning: string | null }>(`admin/domains/lookup?name=${encodeURIComponent(domain)}`)
        .then((r) => setMx(r.name === domain ? r : null))
        .catch(() => setMx(null));
    }, 500);
    return () => clearTimeout(t);
  }, [domain, valid]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    try {
      const d = await api.post<DomainDetail & { providerError: string | null }>("admin/domains", { name: domain, region, receiving, primary: !hasPrimary || primary });
      qc.setQueryData(["admin-domain", d.name], d);
      if (d.providerError) toast.warning(`${d.name} was added here, but not in Resend: ${d.providerError}`);
      else toast.success(`${d.name} added`);
      setName("");
      setMx(null);
      await refresh();
      onAdded?.(d.name);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field
        label="Domain"
        htmlFor="add-domain"
        hint={name && !valid ? "Enter just the domain, like example.com or inbox.example.com." : "The part after the @ in your addresses."}
      >
        <div className="flex gap-2">
          <Input id="add-domain" value={name} onChange={(e) => setName(e.target.value)} placeholder="example.com" autoComplete="off" spellCheck={false} autoCapitalize="none" />
          <Button type="submit" variant="primary" loading={busy} disabled={!valid} icon={<Plus className="size-4" />}>
            Add
          </Button>
        </div>
      </Field>
      {mx?.mxWarning && (
        <div className="animate-in flex gap-2.5 rounded-ui border border-warning/30 bg-warning-soft px-3 py-2.5 text-[13px] text-warning">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div className="space-y-2">
            <p>{mx.mxWarning}</p>
            {providerConnected && (
              <>
                <p>Or turn receiving off and only send from {mx.name} for now.</p>
                <Button type="button" size="xs" variant="secondary" onClick={() => setReceiving(false)} disabled={!receiving}>
                  {receiving ? "Turn off receiving for this domain" : "Receiving is off"}
                </Button>
              </>
            )}
          </div>
        </div>
      )}
      {providerConnected && <ConnectOptions region={region} setRegion={setRegion} receiving={receiving} setReceiving={setReceiving} />}
      {hasPrimary && (
        <label className="flex items-center gap-2 text-[13px] text-fg-muted">
          <Checkbox checked={primary} onChange={setPrimary} label="Make this the primary domain" /> Make this the primary domain (new mailboxes and system emails use it)
        </label>
      )}
    </form>
  );
}
