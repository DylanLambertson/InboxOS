/**
 * Outbound policy: company signatures, legal disclaimer and data-loss prevention.
 * Stored as JSON under the `outbound` key of the settings table and edited from
 * Admin → Signatures & DLP. Pure helpers here are shared by the worker and the UI
 * (the admin preview renders exactly what the server sends).
 */

export type SignatureMode = "off" | "suggest" | "enforce";
export type DlpAction = "off" | "warn" | "block";
export type DlpScope = "external" | "all";
export type DlpRuleId = "card" | "ssn" | "iban" | "secret" | "keyword";

export interface DlpRule {
  action: DlpAction;
  scope: DlpScope;
}

export interface OutboundPolicy {
  signature: {
    mode: SignatureMode;
    /** HTML with {{name}} {{title}} {{email}} {{phone}} {{mailbox}} {{company}} placeholders. */
    template: string;
    /** Mailbox id → template that replaces the org template for that mailbox. */
    mailboxTemplates: Record<string, string>;
  };
  disclaimer: {
    enabled: boolean;
    /** Plain text; rendered small and grey under every outbound message. */
    text: string;
    externalOnly: boolean;
  };
  dlp: {
    rules: Record<DlpRuleId, DlpRule>;
    /** Words or phrases matched case-insensitively as whole words. */
    keywords: string[];
  };
}

export const DLP_RULES: { id: DlpRuleId; label: string; description: string }[] = [
  { id: "card", label: "Credit card numbers", description: "13–19 digit numbers from a known card network that pass the Luhn checksum." },
  { id: "ssn", label: "US Social Security numbers", description: "Written as 123-45-6789 or 123 45 6789, excluding numbers the SSA never issues." },
  { id: "iban", label: "Bank account numbers (IBAN)", description: "International bank account numbers with a valid country length and mod-97 checksum." },
  { id: "secret", label: "API keys and secrets", description: "AWS, Stripe, GitHub, Slack and Google keys, and private key (PEM) blocks." },
  { id: "keyword", label: "Custom keywords", description: "Words or phrases you list below, such as project code names." },
];

export const DEFAULT_OUTBOUND: OutboundPolicy = {
  signature: {
    mode: "off",
    template:
      '<p><strong>{{name}}</strong><br>{{title}}<br>{{company}}</p><p style="color:#6b7280">{{email}} · {{phone}}</p>',
    mailboxTemplates: {},
  },
  disclaimer: { enabled: false, text: "", externalOnly: true },
  dlp: {
    rules: {
      card: { action: "warn", scope: "all" },
      ssn: { action: "warn", scope: "all" },
      iban: { action: "off", scope: "external" },
      secret: { action: "warn", scope: "all" },
      keyword: { action: "off", scope: "external" },
    },
    keywords: [],
  },
};

/** Merge a stored (possibly partial or older) policy over the defaults. */
export function withOutboundDefaults(p: Partial<OutboundPolicy> | null | undefined): OutboundPolicy {
  const d = DEFAULT_OUTBOUND;
  return {
    signature: { ...d.signature, ...p?.signature, mailboxTemplates: { ...p?.signature?.mailboxTemplates } },
    disclaimer: { ...d.disclaimer, ...p?.disclaimer },
    dlp: {
      rules: Object.fromEntries(DLP_RULES.map(({ id }) => [id, { ...d.dlp.rules[id], ...p?.dlp?.rules?.[id] }])) as Record<DlpRuleId, DlpRule>,
      keywords: p?.dlp?.keywords ?? d.dlp.keywords,
    },
  };
}

export interface SignatureVars {
  name: string;
  title: string;
  email: string;
  phone: string;
  mailbox: string;
  company: string;
}

export const SIGNATURE_VARS: (keyof SignatureVars)[] = ["name", "title", "email", "phone", "mailbox", "company"];

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Marks a server-rendered company signature so it is never added twice. */
export const SIGNATURE_MARKER = "data-io-signature";

/**
 * Fill a signature template. Values are HTML-escaped because they come from user
 * profiles; the template itself is admin-authored. Lines whose only content was an
 * empty variable (e.g. no phone) are dropped instead of leaving stray separators.
 */
export function renderSignature(template: string, vars: SignatureVars): string {
  const filled = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) =>
    (SIGNATURE_VARS as string[]).includes(k) ? escapeHtml(vars[k as keyof SignatureVars] ?? "") : m,
  );
  return filled
    .replace(/<(strong|b|em|i|span|a)\b[^>]*>\s*<\/\1>/gi, "")
    .replace(/(<br\s*\/?>)(\s*(?:·|\||-|–)?\s*<br\s*\/?>)+/gi, "$1")
    .replace(/(<br\s*\/?>\s*)+(<\/p>)/gi, "$2")
    .replace(/(<p[^>]*>)\s*(<br\s*\/?>\s*)+/gi, "$1")
    .replace(/\s*·\s*(<\/p>)/g, "$1")
    .replace(/(<p[^>]*>)\s*·\s*/g, "$1")
    .replace(/<p[^>]*>\s*<\/p>/gi, "");
}

/** Wrap a rendered signature for insertion into an outgoing body. */
export const signatureBlock = (html: string) => `<div class="io_signature" ${SIGNATURE_MARKER}="1" style="margin-top:16px">${html}</div>`;

/** True when the address is outside every company mail domain (subdomains count as inside). */
export function isExternal(email: string, domains: string[]): boolean {
  const d = email.split("@").pop()?.trim().toLowerCase() ?? "";
  return !domains.some((x) => d === x || d.endsWith(`.${x}`));
}

export interface DlpFinding {
  rule: DlpRuleId;
  action: Exclude<DlpAction, "off">;
  /** Masked description safe to show the sender, e.g. "Visa card ending 4242". Never the full value. */
  label: string;
}
