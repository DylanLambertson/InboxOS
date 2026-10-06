import {
  fqdnFor,
  purposeOf,
  recommendedDmarc,
  type CheckState,
  type DomainDnsReport,
  type ExpectedRecord,
  type MxHost,
  type RecordCheck,
  type RecordType,
} from "@shared/dns";
import type { ResendDnsRecord } from "./resend";

/**
 * Live DNS checks over DNS-over-HTTPS (Cloudflare's resolver), so the setup wizard can
 * show which records are in place before the provider has re-checked. The comparison
 * logic is pure and unit-tested; only `lookup` touches the network.
 */
const DOH = "https://cloudflare-dns.com/dns-query";
const TYPE_CODE: Record<RecordType, number> = { TXT: 16, MX: 15, CNAME: 5 };

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface DohAnswer {
  name: string;
  type: number;
  data: string;
}

export class DnsLookupError extends Error {}

/** Answers of the given type for a name ([] for NXDOMAIN / no data). */
export async function lookup(name: string, type: RecordType, fetcher: Fetcher = fetch): Promise<string[]> {
  const url = `${DOH}?name=${encodeURIComponent(name)}&type=${type}`;
  let res: Response;
  try {
    res = await fetcher(url, { headers: { accept: "application/dns-json" } });
  } catch {
    throw new DnsLookupError("Couldn't reach the DNS resolver.");
  }
  if (!res.ok) throw new DnsLookupError(`DNS lookup failed (${res.status}).`);
  return parseDohAnswers(await res.json(), type);
}

/** Pull the answers of one type out of a DoH JSON response (CNAME chains are skipped). */
export function parseDohAnswers(json: unknown, type: RecordType): string[] {
  const j = (json && typeof json === "object" ? json : {}) as { Status?: number; Answer?: unknown };
  // 0 = NOERROR, 3 = NXDOMAIN (no such name: simply nothing found).
  if (j.Status !== undefined && j.Status !== 0 && j.Status !== 3) throw new DnsLookupError(`DNS lookup failed (status ${j.Status}).`);
  const answers = Array.isArray(j.Answer) ? (j.Answer as DohAnswer[]) : [];
  return answers.filter((a) => a && a.type === TYPE_CODE[type] && typeof a.data === "string").map((a) => (type === "TXT" ? normalizeTxt(a.data) : a.data.trim()));
}

/** `"v=spf1 " "include:x ~all"` → `v=spf1 include:x ~all` (joins split strings, drops quotes). */
export function normalizeTxt(data: string): string {
  const parts = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, "$1"));
  return parts.length ? parts.join("") : data.trim();
}

const host = (h: string) => h.trim().toLowerCase().replace(/\.$/, "");
const squash = (s: string) => s.replace(/\s+/g, "").replace(/;$/, "").toLowerCase();

export function parseMx(data: string): { priority: number; host: string } | null {
  const m = /^\s*(\d+)\s+(\S+)\s*$/.exec(data);
  return m ? { priority: Number(m[1]), host: host(m[2]) } : null;
}

/** Name the mail service behind an MX host, so warnings can say "Google Workspace", not a host name. */
export function mailProviderFor(mxHost: string): string | null {
  const h = host(mxHost);
  const known: [RegExp, string][] = [
    [/(^|\.)google\.com$|(^|\.)googlemail\.com$/, "Google Workspace"],
    [/(^|\.)outlook\.com$|(^|\.)office365\.us$/, "Microsoft 365"],
    [/(^|\.)zoho\.(com|eu|in|com\.au)$/, "Zoho Mail"],
    [/(^|\.)protonmail\.ch$|(^|\.)proton\.me$/, "Proton Mail"],
    [/(^|\.)messagingengine\.com$/, "Fastmail"],
    [/(^|\.)icloud\.com$/, "iCloud Mail"],
    [/(^|\.)mimecast\.com$/, "Mimecast"],
    [/(^|\.)secureserver\.net$/, "GoDaddy email"],
    [/(^|\.)privateemail\.com$|(^|\.)registrar-servers\.com$/, "Namecheap email"],
    [/(^|\.)yandex\.(net|ru)$/, "Yandex Mail"],
    [/(^|\.)mx\.cloudflare\.net$/, "Cloudflare Email Routing"],
    [/(^|\.)improvmx\.com$/, "ImprovMX"],
    [/(^|\.)forwardemail\.net$/, "Forward Email"],
    [/(^|\.)mailgun\.org$/, "Mailgun"],
    [/(^|\.)sendgrid\.net$/, "SendGrid"],
  ];
  return known.find(([re]) => re.test(h))?.[1] ?? null;
}

/** Inbound MX hosts of the email provider (Resend receives through Amazon SES). */
export const isProviderInboundMx = (mxHost: string) => /^inbound-smtp\.[a-z0-9-]+\.amazonaws\.com$/.test(host(mxHost));

/** Map Resend's records to the expected records for a domain. */
export function expectedFromResend(domain: string, records: ResendDnsRecord[]): ExpectedRecord[] {
  return records
    .filter((r) => r.type === "TXT" || r.type === "MX" || r.type === "CNAME")
    .map((r) => ({
      purpose: purposeOf(r.record, r.type, r.value),
      type: r.type as RecordType,
      name: r.name || "@",
      fqdn: fqdnFor(r.name, domain),
      value: r.value,
      ...(r.priority !== undefined ? { priority: r.priority } : {}),
      providerStatus: r.status,
      ...(purposeOf(r.record, r.type, r.value) === "tracking" ? { optional: true } : {}),
    }));
}

/** Compare what DNS returns for one expected record. `found` is the lookup result for its name and type. */
export function compareRecord(expected: ExpectedRecord, found: string[]): RecordCheck {
  const result = (state: CheckState, note?: string): RecordCheck => ({ ...expected, state, found, ...(note ? { note } : {}) });
  if (expected.type === "MX") {
    const mx = found.map(parseMx).filter((m): m is NonNullable<ReturnType<typeof parseMx>> => !!m);
    const want = host(expected.value);
    const match = mx.find((m) => m.host === want);
    if (!match) return mx.length ? result("mismatched", "There are MX records here, but not this one.") : result("missing");
    if (expected.purpose === "receiving") {
      // Mail goes to the lowest priority number; anything at or below ours competes for it.
      const rivals = mx.filter((m) => m.host !== want && m.priority <= match.priority);
      if (rivals.length) return result("mismatched", `Other MX records have the same or a lower priority (${rivals.map((r) => r.host).join(", ")}), so some or all mail won't arrive here. Remove them or give this record the lowest number.`);
    }
    if (expected.priority !== undefined && match.priority !== expected.priority && expected.purpose !== "receiving") {
      return result("found", `Priority is ${match.priority} instead of ${expected.priority}; that still works.`);
    }
    return result("found");
  }
  if (expected.type === "CNAME") {
    if (!found.length) return result("missing");
    return found.some((f) => host(f) === host(expected.value)) ? result("found") : result("mismatched", "This name points somewhere else.");
  }
  // TXT
  if (expected.purpose === "spf") {
    const spf = found.filter((t) => /^v=spf1\b/i.test(t.trim()));
    if (!spf.length) return result("missing");
    if (spf.length > 1) return result("mismatched", "There is more than one SPF record here. Merge them into one, or receivers will ignore both.");
    const includes = [...expected.value.matchAll(/include:(\S+)/gi)].map((m) => m[1].toLowerCase());
    const have = spf[0].toLowerCase();
    const missing = includes.filter((inc) => !have.includes(`include:${inc}`));
    if (missing.length) return result("mismatched", `The SPF record exists but doesn't include ${missing.join(", ")}. Add it to the existing record rather than creating a second one.`);
    return result("found");
  }
  if (!found.length) return result("missing");
  return found.some((f) => squash(f) === squash(expected.value)) ? result("found") : result("mismatched", "A record exists here but its value is different. Replace it with the value shown.");
}

/** DMARC is recommended, not required: any valid v=DMARC1 record counts. */
export function checkDmarc(domain: string, found: string[]): RecordCheck {
  const expected = recommendedDmarc(domain);
  const dmarc = found.filter((t) => /^v=DMARC1\b/i.test(t.trim()));
  if (!dmarc.length) return { ...expected, state: "missing", found, note: "Recommended: tells receivers what to do with mail that fails checks. Start with p=none." };
  if (dmarc.length > 1) return { ...expected, state: "mismatched", found, note: "There is more than one DMARC record; keep only one." };
  return { ...expected, state: "found", found };
}

/** MX records that send mail somewhere other than the provider, and a warning when there are any. */
export function existingMailWarning(domain: string, mx: string[], receivingName: string): { existingMx: MxHost[]; mxWarning: string | null } {
  const existingMx = mx
    .map(parseMx)
    .filter((m): m is NonNullable<ReturnType<typeof parseMx>> => !!m && !isProviderInboundMx(m.host) && m.host !== "")
    .map((m) => ({ ...m, provider: mailProviderFor(m.host) }));
  if (!existingMx.length) return { existingMx, mxWarning: null };
  const who = existingMx.find((m) => m.provider)?.provider ?? "another mail service";
  const advice = receivingName === domain ? ` To keep both, use a subdomain such as inbox.${domain} for this app instead.` : "";
  return {
    existingMx,
    mxWarning: `${receivingName} already receives mail through ${who}. Pointing its MX records here moves all of that mail to this app, and ${who} stops getting it.${advice}`,
  };
}

/** Look up every expected record (plus DMARC and existing MX) and compare. */
export async function checkDomainDns(domain: string, expected: ExpectedRecord[], fetcher: Fetcher = fetch): Promise<DomainDnsReport> {
  // null = the lookup itself failed: report "unknown" rather than "missing".
  const cache = new Map<string, Promise<string[] | null>>();
  const get = (name: string, type: RecordType) => {
    const k = `${type} ${name}`;
    if (!cache.has(k)) cache.set(k, lookup(name, type, fetcher).catch(() => null));
    return cache.get(k)!;
  };
  const unknown = (e: ExpectedRecord): RecordCheck => ({ ...e, state: "unknown", found: [], note: "Couldn't look this up right now. Try again in a moment." });
  const receivingName = expected.find((e) => e.purpose === "receiving")?.fqdn ?? domain;
  const [records, dmarcTxt, mx] = await Promise.all([
    Promise.all(
      expected.map(async (e) => {
        const found = await get(e.fqdn, e.type);
        return found ? compareRecord(e, found) : unknown(e);
      }),
    ),
    get(`_dmarc.${domain}`, "TXT"),
    get(receivingName, "MX"),
  ]);
  return {
    domain,
    records,
    dmarc: dmarcTxt ? checkDmarc(domain, dmarcTxt) : unknown(recommendedDmarc(domain)),
    ...existingMailWarning(domain, mx ?? [], receivingName),
    checkedAt: new Date().toISOString(),
  };
}

/** Only the MX check, for warning before a domain is added. */
export async function existingMail(domain: string, fetcher: Fetcher = fetch) {
  const mx = await lookup(domain, "MX", fetcher).catch(() => [] as string[]);
  return existingMailWarning(domain, mx, domain);
}
