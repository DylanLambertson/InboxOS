import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { RESEND_REGIONS } from "@shared/setup";
import { api, errorMessage } from "@/lib/api";
import { useDomainDetail, useRefreshSetup, type DomainDetail } from "@/lib/setup";
import { Button, Field, LoadError, Select, Spinner, Switch } from "@/components/ui/primitives";
import { DnsRecordTable } from "./DnsRecordTable";
import { ProviderHints } from "./ProviderHints";
import { domainStatusInfo, DomainStatusBadge } from "./StatusBadges";

/** Region picker and receiving switch, used when a domain is created in Resend. */
export function ConnectOptions({ region, setRegion, receiving, setReceiving }: { region: string; setRegion: (v: string) => void; receiving: boolean; setReceiving: (v: boolean) => void }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Sending region" hint="Pick the one closest to most of your recipients.">
        <Select value={region} onChange={(e) => setRegion(e.target.value)}>
          {RESEND_REGIONS.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Receive mail here" hint="Adds an MX record so mail to this domain arrives in the app.">
        <div className="flex h-9 items-center">
          <Switch checked={receiving} onChange={setReceiving} label="Receive mail at this domain" />
        </div>
      </Field>
    </div>
  );
}

function NotConnected({ detail, onConnected }: { detail: DomainDetail; onConnected: (d: DomainDetail) => void }) {
  const [region, setRegion] = useState("us-east-1");
  const [receiving, setReceiving] = useState(true);
  const [busy, setBusy] = useState(false);
  if (detail.providerError) {
    return <p className="rounded-ui bg-subtle px-3 py-2.5 text-[13px] text-fg-muted">{detail.providerError} Connect the email provider, then come back to get this domain's DNS records.</p>;
  }
  const connect = async () => {
    setBusy(true);
    try {
      onConnected(await api.post<DomainDetail>(`admin/domains/${encodeURIComponent(detail.name)}/connect`, { region, receiving }));
      toast.success(`${detail.name} added to Resend`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <p className="text-[13px] text-fg-muted">This domain isn't in your Resend account yet. Add it there to get the DNS records to set up.</p>
      <ConnectOptions region={region} setRegion={setRegion} receiving={receiving} setReceiving={setReceiving} />
      <Button variant="primary" loading={busy} onClick={connect}>
        Add to Resend
      </Button>
    </div>
  );
}

/**
 * Everything needed to get one domain working: its status, the DNS records with live
 * checks, help for the common DNS providers, and verify / re-check actions.
 */
export function DomainSetupPanel({ name }: { name: string }) {
  const { data, error, isLoading, refetch, isFetching } = useDomainDetail(name);
  const qc = useQueryClient();
  const refresh = useRefreshSetup();
  const [busy, setBusy] = useState<"verify" | "receiving" | null>(null);

  if (isLoading) return <Spinner className="mx-auto my-6 size-5" />;
  if (error || !data) return <LoadError error={error} onRetry={() => refetch()} />;
  const set = (d: DomainDetail) => {
    qc.setQueryData(["admin-domain", name], d);
    void refresh();
  };
  if (!data.provider) return <NotConnected detail={data} onConnected={set} />;

  const p = data.provider;
  const dns = data.dns;
  const info = domainStatusInfo(p.status);
  const records = dns?.records ?? [];
  const zoneRecords = dns?.dmarc && dns.dmarc.state === "missing" ? [...records, dns.dmarc] : records;

  const act = async (kind: "verify" | "receiving", run: () => Promise<DomainDetail>, ok: string) => {
    setBusy(kind);
    try {
      set(await run());
      toast.success(ok);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <DomainStatusBadge status={p.status} />
        <span className="text-[13px] text-fg-muted">{info.hint}</span>
      </div>

      {dns?.mxWarning && (
        <div className="flex gap-2.5 rounded-ui border border-warning/30 bg-warning-soft px-3 py-2.5 text-[13px] text-warning">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{dns.mxWarning}</span>
        </div>
      )}

      <DnsRecordTable domain={name} records={records} dmarc={dns?.dmarc} />

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" icon={<RefreshCw className={isFetching ? "size-4 animate-spin" : "size-4"} />} onClick={() => refetch()} disabled={isFetching}>
          Check again
        </Button>
        {p.status !== "verified" && (
          <Button
            size="sm"
            variant="primary"
            icon={<ShieldCheck className="size-4" />}
            loading={busy === "verify"}
            onClick={() => act("verify", () => api.post<DomainDetail>(`admin/domains/${encodeURIComponent(name)}/verify`), "Resend is checking the records now")}
          >
            Verify with Resend
          </Button>
        )}
        {dns && <span className="text-xs text-fg-faint">DNS checked {new Date(dns.checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}. Changes can take a few minutes to show up.</span>}
      </div>

      <label className="flex items-start justify-between gap-4 rounded-ui border border-line px-3 py-2.5">
        <span>
          <span className="block text-[13px] font-medium text-fg">Receive mail at {name}</span>
          <span className="block text-xs text-fg-muted">
            {p.receiving ? "Mail sent to any address here arrives in the app once the MX record is in place." : "Off: this domain only sends. Turn on to get an MX record for receiving."}
          </span>
        </span>
        <Switch
          checked={p.receiving}
          disabled={busy === "receiving"}
          label={`Receive mail at ${name}`}
          onChange={(v) => act("receiving", () => api.put<DomainDetail>(`admin/domains/${encodeURIComponent(name)}/receiving`, { enabled: v }), v ? "Receiving turned on" : "Receiving turned off")}
        />
      </label>

      <ProviderHints domain={name} records={zoneRecords} />
    </div>
  );
}
