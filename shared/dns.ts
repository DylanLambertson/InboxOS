/**
 * DNS records a mail domain needs, the result of checking them live, and helpers
 * the app uses to show them (copyable values, host names for DNS providers, a
 * BIND zone snippet). The lookups themselves run in the worker (worker/lib/dns.ts).
 */

export type RecordType = "TXT" | "MX" | "CNAME";
/** What a record is for, in plain terms. */
export type RecordPurpose = "dkim" | "spf" | "bounce" | "receiving" | "tracking" | "dmarc" | "other";
export type CheckState = "found" | "missing" | "mismatched" | "unknown";

export interface ExpectedRecord {
  purpose: RecordPurpose;
  type: RecordType;
  /** Name as the provider gives it, relative to the domain (e.g. "send", "resend._domainkey", "@"). */
  name: string;
  /** Fully qualified name, without a trailing dot. */
  fqdn: string;
  value: string;
  priority?: number;
  /** The provider's own verification status for this record, when known. */
  providerStatus?: string;
  /** Recommended but not required (DMARC, tracking). */
  optional?: boolean;
}

export interface RecordCheck extends ExpectedRecord {
  state: CheckState;
  /** What DNS currently returns for this name and type. */
  found: string[];
  /** Plain-language explanation when something is off. */
  note?: string;
}

export interface MxHost {
  host: string;
  priority: number;
  /** Recognised mail service, e.g. "Google Workspace". */
  provider: string | null;
}

export interface DomainDnsReport {
  domain: string;
  records: RecordCheck[];
  /** Recommended DMARC record check (never blocks verification). */
  dmarc: RecordCheck;
  /** MX records on the receiving name that point somewhere other than the provider. */
  existingMx: MxHost[];
  /** Set when switching MX would move mail away from another service. */
  mxWarning: string | null;
  checkedAt: string;
}

export const PURPOSE_LABEL: Record<RecordPurpose, string> = {
  dkim: "DKIM signature",
  spf: "SPF (sending permission)",
  bounce: "Bounce handling",
  receiving: "Receiving (MX)",
  tracking: "Open/click tracking",
  dmarc: "DMARC policy",
  other: "Other",
};

/** Classify a record from the provider's label ("DKIM", "SPF", "Receiving", "Tracking"…). */
export function purposeOf(label: string, type: string, value: string): RecordPurpose {
  const l = label.toLowerCase();
  if (l.includes("dkim")) return "dkim";
  if (l.includes("receiv") || l.includes("inbound") || (type === "MX" && /inbound-smtp/i.test(value))) return "receiving";
  if (l.includes("spf")) return type === "MX" ? "bounce" : "spf";
  if (l.includes("track")) return "tracking";
  if (l.includes("dmarc")) return "dmarc";
  return "other";
}

/**
 * The fully qualified name for a record name relative to a mail domain.
 * Providers give names relative to the domain ("send" → send.example.com) but for a
 * subdomain they may repeat its labels ("send.mail" on mail.example.com), so a name
 * that already ends with the domain's leading labels is attached to the rest.
 */
export function fqdnFor(name: string, domain: string): string {
  const n = name.trim().toLowerCase().replace(/\.$/, "");
  const d = domain.trim().toLowerCase().replace(/\.$/, "");
  if (!n || n === "@") return d;
  if (n === d || n.endsWith(`.${d}`)) return n;
  const labels = d.split(".");
  // Try the longest leading part first: "a.b" of a.b.example.com, then "a".
  for (let k = labels.length - 2; k >= 1; k--) {
    const lead = labels.slice(0, k).join(".");
    if (n === lead || n.endsWith(`.${lead}`)) return `${n}.${labels.slice(k).join(".")}`;
  }
  return `${n}.${d}`;
}

/** The host to type at a DNS provider that wants names relative to the zone (apex). */
export function hostInZone(fqdn: string, zone: string): string {
  const f = fqdn.toLowerCase();
  const z = zone.toLowerCase();
  if (f === z) return "@";
  return f.endsWith(`.${z}`) ? f.slice(0, -z.length - 1) : f;
}

/** Best guess at the registered zone of a domain (last two labels, three for e.g. co.uk). */
export function guessZone(domain: string): string {
  const labels = domain.toLowerCase().split(".");
  const twoLevel = /^(co|com|net|org|gov|ac|edu)$/.test(labels.at(-2) ?? "") && (labels.at(-1)?.length ?? 0) === 2;
  return labels.slice(-(twoLevel ? 3 : 2)).join(".");
}

/** Split a long TXT value into quoted 255-character strings, as zone files require. */
export function quoteTxt(value: string): string {
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += 255) chunks.push(value.slice(i, i + 255));
  return (chunks.length ? chunks : [""]).map((c) => `"${c.replace(/(["\\])/g, "\\$1")}"`).join(" ");
}

/** A BIND zone-file snippet for the records, ready to import at most DNS providers. */
export function bindZone(domain: string, records: ExpectedRecord[], ttl = 3600): string {
  const abs = (h: string) => (h.endsWith(".") ? h : `${h}.`);
  const lines = [`; Mail records for ${domain}`, `$TTL ${ttl}`];
  for (const r of records) {
    const rdata =
      r.type === "MX" ? `${r.priority ?? 10} ${abs(r.value)}` : r.type === "CNAME" ? abs(r.value) : quoteTxt(r.value);
    lines.push(`${abs(r.fqdn)}\t${ttl}\tIN\t${r.type}\t${rdata}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The DMARC record we recommend starting with: monitor only, nothing gets rejected. */
export const recommendedDmarc = (domain: string): ExpectedRecord => ({
  purpose: "dmarc",
  type: "TXT",
  name: "_dmarc",
  fqdn: `_dmarc.${domain}`,
  value: "v=DMARC1; p=none;",
  optional: true,
});

export interface DnsProviderHint {
  id: string;
  name: string;
  /** Where to go and what to type, in order. */
  steps: string[];
  /** How the provider wants host names: relative to the zone (send) or in full (send.example.com). */
  hostFormat: "relative" | "full";
}

export const DNS_PROVIDER_HINTS: DnsProviderHint[] = [
  {
    id: "cloudflare",
    name: "Cloudflare",
    hostFormat: "relative",
    steps: [
      "Open your domain in the Cloudflare dashboard and go to DNS → Records.",
      "Click Add record, pick the type, and paste the Name and Content. Cloudflare adds your domain to the name for you.",
      "For CNAME records, set Proxy status to DNS only (grey cloud). Mail records must not be proxied.",
      "Or use Import and Export → Import DNS records, and upload the zone file below.",
    ],
  },
  {
    id: "namecheap",
    name: "Namecheap",
    hostFormat: "relative",
    steps: [
      "Go to Domain List → Manage → Advanced DNS.",
      "Under Host Records, click Add New Record and choose the type. Use the relative host (e.g. send), or @ for the domain itself.",
      "MX records go under Mail Settings: switch it to Custom MX first.",
    ],
  },
  {
    id: "godaddy",
    name: "GoDaddy",
    hostFormat: "relative",
    steps: [
      "Go to My Products → your domain → DNS → DNS Records.",
      "Click Add New Record, choose the type, and enter the relative name (e.g. send), or @ for the domain itself.",
      "Leave TTL at the default.",
    ],
  },
  {
    id: "route53",
    name: "Amazon Route 53",
    hostFormat: "relative",
    steps: [
      "Open Route 53 → Hosted zones → your domain → Create record.",
      "Enter the subdomain part in Record name and choose the type.",
      "TXT values must be wrapped in double quotes; MX values are \"10 host\" (priority, a space, then the server).",
      "Or import the zone file below with Import zone file.",
    ],
  },
  {
    id: "google",
    name: "Google Domains / Squarespace",
    hostFormat: "relative",
    steps: [
      "Google Domains moved to Squarespace: open Domains → your domain → DNS → DNS Settings.",
      "Under Custom records, click Add record, choose the type and enter the relative host (e.g. send), or @ for the domain itself.",
      "MX records need the priority in its own field.",
    ],
  },
  {
    id: "other",
    name: "Another provider",
    hostFormat: "relative",
    steps: [
      "Find your provider's DNS settings (sometimes called Zone editor or Advanced DNS).",
      "Add each record below with its type, host and value. Most providers want the host without your domain (e.g. send), and @ for the domain itself.",
      "If your provider can import a zone file, download the one below and import it instead.",
    ],
  },
];
