import { guessZone, hostInZone, PURPOSE_LABEL, type ExpectedRecord, type RecordCheck } from "@shared/dns";
import { Badge, cx } from "@/components/ui/primitives";
import { CopyButton, RecordStateBadge } from "./StatusBadges";

const isCheck = (r: ExpectedRecord | RecordCheck): r is RecordCheck => "state" in r;

function Cell({ label, value, mono = true, className }: { label: string; value: string; mono?: boolean; className?: string }) {
  return (
    <div className={cx("min-w-0", className)}>
      <div className="text-[11px] font-medium text-fg-faint md:hidden">{label}</div>
      <div className="flex min-w-0 items-center gap-0.5">
        <span className={cx("min-w-0 flex-1 truncate text-[13px] text-fg", mono && "font-mono text-xs")} title={value}>
          {value}
        </span>
        <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />
      </div>
    </div>
  );
}

/**
 * The DNS records a domain needs, ready to copy into a DNS provider, each with its
 * live status when checked. Hosts are shown relative to the zone, the way most DNS
 * providers want them; the full name is in the tooltip and the zone file.
 */
export function DnsRecordTable({ domain, records, dmarc }: { domain: string; records: (ExpectedRecord | RecordCheck)[]; dmarc?: RecordCheck | null }) {
  const zone = guessZone(domain);
  const rows = dmarc ? [...records, dmarc] : records;
  if (!rows.length) return <p className="text-[13px] text-fg-muted">No records to add yet.</p>;
  return (
    <div className="overflow-hidden rounded-ui border border-line">
      <div className="hidden grid-cols-[minmax(0,1.1fr)_56px_minmax(0,1fr)_minmax(0,2fr)_48px] gap-3 border-b border-line bg-subtle px-3 py-2 text-[11px] font-medium tracking-wide text-fg-muted uppercase md:grid">
        <span>Record</span>
        <span>Type</span>
        <span>Host</span>
        <span>Value</span>
        <span>Priority</span>
      </div>
      <ul className="divide-y divide-line">
        {rows.map((r) => {
          const host = hostInZone(r.fqdn, zone);
          return (
            <li key={`${r.type}-${r.fqdn}-${r.value}`} className="px-3 py-2.5">
              <div className="grid grid-cols-2 gap-x-3 gap-y-2 md:grid-cols-[minmax(0,1.1fr)_56px_minmax(0,1fr)_minmax(0,2fr)_48px] md:items-center">
                <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-1.5 md:col-span-1">
                  <span className="truncate text-[13px] font-medium text-fg">{PURPOSE_LABEL[r.purpose]}</span>
                  {r.optional && <Badge>Recommended</Badge>}
                  {isCheck(r) && <RecordStateBadge state={r.state} />}
                </div>
                <div>
                  <div className="text-[11px] font-medium text-fg-faint md:hidden">Type</div>
                  <span className="font-mono text-xs font-semibold text-fg">{r.type}</span>
                </div>
                <div className="md:hidden">
                  {r.type === "MX" && (
                    <>
                      <div className="text-[11px] font-medium text-fg-faint">Priority</div>
                      <span className="font-mono text-xs">{r.priority ?? 10}</span>
                    </>
                  )}
                </div>
                <Cell label="Host" value={host} className="col-span-2 md:col-span-1" />
                <Cell label="Value" value={r.value} className="col-span-2 md:col-span-1" />
                <span className="hidden font-mono text-xs md:block">{r.type === "MX" ? (r.priority ?? 10) : "—"}</span>
              </div>
              {isCheck(r) && r.note && (
                <p className={cx("mt-1.5 text-xs", r.state === "mismatched" ? "text-danger" : r.state === "unknown" ? "text-warning" : "text-fg-muted")}>{r.note}</p>
              )}
              {isCheck(r) && r.state === "mismatched" && r.found.length > 0 && (
                <p className="mt-1 truncate font-mono text-[11px] text-fg-faint" title={r.found.join("\n")}>
                  Currently: {r.found.join(" · ")}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
