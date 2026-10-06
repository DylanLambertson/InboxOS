import { useState } from "react";
import { Download } from "lucide-react";
import { bindZone, DNS_PROVIDER_HINTS, type ExpectedRecord } from "@shared/dns";
import { Button, cx } from "@/components/ui/primitives";

/** Step-by-step help for the common DNS providers, plus a zone file to import. */
export function ProviderHints({ domain, records }: { domain: string; records: ExpectedRecord[] }) {
  const [id, setId] = useState<string | null>(null);
  const hint = DNS_PROVIDER_HINTS.find((h) => h.id === id);
  const download = () => {
    const blob = new Blob([bindZone(domain, records)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${domain}.zone.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] text-fg-muted">Where is your DNS?</span>
        {DNS_PROVIDER_HINTS.map((h) => (
          <button
            key={h.id}
            type="button"
            aria-pressed={id === h.id}
            onClick={() => setId(id === h.id ? null : h.id)}
            className={cx(
              "h-7 rounded-full border px-3 text-xs font-medium transition-colors",
              id === h.id ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface text-fg-muted hover:border-line-strong hover:text-fg",
            )}
          >
            {h.name}
          </button>
        ))}
      </div>
      {hint && (
        <ol className="animate-in list-decimal space-y-1.5 rounded-ui bg-subtle py-3 pr-4 pl-8 text-[13px] text-fg-muted marker:text-fg-faint">
          {hint.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      )}
      <Button size="sm" variant="ghost" icon={<Download className="size-4" />} onClick={download} disabled={!records.length}>
        Download zone file
      </Button>
    </div>
  );
}
