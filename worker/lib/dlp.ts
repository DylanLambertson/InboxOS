import type { DlpFinding, DlpRuleId, OutboundPolicy } from "@shared/outbound";

/**
 * Data-loss prevention detectors. Each returns masked labels only: the raw value is
 * never returned, logged or stored. Every detector validates a checksum or structure
 * on top of the pattern, because plain digit-count matching flags order numbers,
 * phone numbers and timestamps all day long.
 */

const last4 = (s: string) => s.slice(-4);

// ---- Payment cards ----------------------------------------------------------

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Card network for a number, by issuer prefix and length; null when no network issues it. */
export function cardNetwork(n: string): string | null {
  const len = n.length;
  const p2 = +n.slice(0, 2);
  const p3 = +n.slice(0, 3);
  const p4 = +n.slice(0, 4);
  const p6 = +n.slice(0, 6);
  if (n[0] === "4" && (len === 13 || len === 16 || len === 19)) return "Visa";
  if (((p2 >= 51 && p2 <= 55) || (p4 >= 2221 && p4 <= 2720)) && len === 16) return "Mastercard";
  if ((p2 === 34 || p2 === 37) && len === 15) return "Amex";
  if ((p4 === 6011 || p2 === 65 || (p3 >= 644 && p3 <= 649) || (p6 >= 622126 && p6 <= 622925)) && len >= 16 && len <= 19) return "Discover";
  if (p4 >= 3528 && p4 <= 3589 && len >= 16 && len <= 19) return "JCB";
  if ((p3 >= 300 && p3 <= 305) || p2 === 36 || p2 === 38 || p2 === 39) return len >= 14 && len <= 19 ? "Diners Club" : null;
  if (p2 === 62 && len >= 16 && len <= 19) return "UnionPay";
  return null;
}

// Digit runs that may contain single spaces or dashes, not touching other digits/letters.
const CARD_RE = /(?<![\w.,/-])\d(?:[ -]?\d){12,18}(?![\w/]|[.,-]\d)/g;

export function findCards(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(CARD_RE)) {
    const raw = m[0];
    // Mixed separators ("4111-1111 1111.1111") are how tables and IDs look, not cards.
    const seps = new Set(raw.replace(/\d/g, ""));
    if (seps.size > 1) continue;
    if (seps.size === 1) {
      const groups = raw.split(/[ -]/).map((g) => g.length);
      // Cards are written in groups of 4 (Amex 4-6-5, Diners 4-6-4); anything else is some other number.
      const ok = groups.slice(0, -1).every((g) => g === 4 || g === 6) && groups[0] === 4 && groups.at(-1)! >= 3;
      if (!ok) continue;
    }
    const n = raw.replace(/\D/g, "");
    if (/^(\d)\1+$/.test(n)) continue;
    const network = cardNetwork(n);
    if (!network || !luhnValid(n)) continue;
    out.push(`${network} card ending ${last4(n)}`);
  }
  return out;
}

// ---- US Social Security numbers --------------------------------------------

/** Numbers the SSA has never issued or that are famous examples (Woolworth wallet card, etc.). */
const SSN_EXAMPLES = new Set(["078051120", "219099999", "123456789", "111111111", "333333333", "987654320", "987654321"]);

export function ssnValid(area: string, group: string, serial: string): boolean {
  const a = +area;
  if (a === 0 || a === 666 || a >= 900) return false;
  if (group === "00" || serial === "0000") return false;
  return !SSN_EXAMPLES.has(area + group + serial);
}

// Only the written formats (dashes or spaces): bare 9-digit runs are mostly IDs and zip+4s.
const SSN_RE = /(?<![\w.,/:-])(\d{3})([- ])(\d{2})\2(\d{4})(?![\w/]|[.,:-]\d)/g;

export function findSsns(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(SSN_RE)) {
    if (ssnValid(m[1], m[3], m[4])) out.push(`SSN ending ${m[4]}`);
  }
  return out;
}

// ---- IBAN -------------------------------------------------------------------

/** Country → IBAN length (SWIFT registry), for the countries most mail goes to. */
const IBAN_LENGTHS: Record<string, number> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, CH: 21, CR: 22, CY: 28, CZ: 24,
  DE: 22, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27,
  GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LI: 21, LT: 20, LU: 20,
  LV: 21, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31, MU: 30, NL: 18, NO: 15, PK: 24, PL: 28, PS: 29, PT: 25,
  QA: 29, RO: 24, RS: 22, SA: 24, SE: 24, SI: 19, SK: 24, SM: 27, TN: 24, TR: 26, UA: 29, VG: 24, XK: 20,
};

export function ibanValid(iban: string): boolean {
  const s = iban.toUpperCase();
  if (IBAN_LENGTHS[s.slice(0, 2)] !== s.length || !/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  // Letters become 10..35; reduce piecewise so the number never exceeds a double's precision.
  let rem = 0;
  for (const ch of moved) {
    const v = ch >= "A" ? (ch.charCodeAt(0) - 55).toString() : ch;
    for (const d of v) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

const IBAN_RE = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){10,30}/gi;

export function findIbans(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(IBAN_RE)) {
    const compact = m[0].replace(/ /g, "").toUpperCase();
    const len = IBAN_LENGTHS[compact.slice(0, 2)];
    // The pattern can run into a following word; try the exact country length.
    if (!len || compact.length < len) continue;
    const candidate = compact.slice(0, len);
    if (ibanValid(candidate)) out.push(`IBAN ${candidate.slice(0, 2)} ending ${last4(candidate)}`);
  }
  return out;
}

// ---- API keys and secrets ---------------------------------------------------

const SECRET_PATTERNS: { name: string; re: RegExp; showTail?: boolean }[] = [
  { name: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, showTail: true },
  { name: "Stripe secret key", re: /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/g, showTail: true },
  { name: "GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g, showTail: true },
  { name: "GitHub token", re: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g, showTail: true },
  { name: "Slack token", re: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/g, showTail: true },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g, showTail: true },
  { name: "Private key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g },
];

export function findSecrets(text: string): string[] {
  const out: string[] = [];
  for (const { name, re, showTail } of SECRET_PATTERNS) {
    for (const m of text.matchAll(re)) out.push(showTail ? `${name} ending ${last4(m[0])}` : `${name} block`);
  }
  return out;
}

// ---- Custom keywords --------------------------------------------------------

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function findKeywords(text: string, keywords: string[]): string[] {
  const out: string[] = [];
  for (const kw of keywords.map((k) => k.trim()).filter(Boolean)) {
    // Whole words only, so "art" doesn't fire on "start"; spaces in phrases match any whitespace.
    const body = kw.split(/\s+/).map(reEscape).join("\\s+");
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, "iu");
    if (re.test(text)) out.push(`Keyword "${kw}"`);
  }
  return out;
}

// ---- Policy evaluation ------------------------------------------------------

export interface DlpInput {
  subject: string;
  /** Plain-text body (already converted from HTML). */
  text: string;
  filenames: string[];
  /** Whether any recipient is outside the company domains. */
  hasExternal: boolean;
}

const MAX_FINDINGS = 25;

/** Run every enabled rule that applies to these recipients; findings are de-duplicated. */
export function scanOutbound(policy: OutboundPolicy["dlp"], input: DlpInput): DlpFinding[] {
  const haystack = [input.subject, input.text, ...input.filenames].join("\n");
  const detectors: Record<DlpRuleId, () => string[]> = {
    card: () => findCards(haystack),
    ssn: () => findSsns(haystack),
    iban: () => findIbans(haystack),
    secret: () => findSecrets(haystack),
    keyword: () => findKeywords(haystack, policy.keywords),
  };
  const findings: DlpFinding[] = [];
  const seen = new Set<string>();
  for (const id of Object.keys(detectors) as DlpRuleId[]) {
    const rule = policy.rules[id];
    if (!rule || rule.action === "off") continue;
    if (rule.scope === "external" && !input.hasExternal) continue;
    for (const label of detectors[id]()) {
      if (seen.has(label)) continue;
      seen.add(label);
      findings.push({ rule: id, action: rule.action, label });
    }
  }
  // Blocks first so a truncated list never hides why a send was refused.
  return findings.sort((a, b) => (a.action === b.action ? 0 : a.action === "block" ? -1 : 1)).slice(0, MAX_FINDINGS);
}

/** Per-rule counts for audit logs: what fired, never the values. */
export function summarizeFindings(findings: DlpFinding[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of findings) out[f.rule] = (out[f.rule] ?? 0) + 1;
  return out;
}
