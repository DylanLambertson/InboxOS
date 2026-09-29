import { mailDomains, type Brand } from "@shared/brand";
import {
  isExternal,
  renderSignature,
  signatureBlock,
  withOutboundDefaults,
  type DlpFinding,
  type OutboundPolicy,
  type SignatureMode,
} from "@shared/outbound";
import type { Address } from "@shared/types";
import { scanOutbound, summarizeFindings } from "./dlp";
import { getBrand } from "./settings";
import { escapeHtml, htmlToText, newId, now, parseJson } from "./util";

// ---- Storage ------------------------------------------------------------------

let cache: { at: number; policy: OutboundPolicy } | null = null;
const TTL = 15_000;

export async function getOutboundPolicy(db: D1Database): Promise<OutboundPolicy> {
  if (cache && Date.now() - cache.at < TTL) return cache.policy;
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'outbound'").first<{ value: string }>();
  const policy = withOutboundDefaults(parseJson<Partial<OutboundPolicy>>(row?.value, {}));
  cache = { at: Date.now(), policy };
  return policy;
}

export async function saveOutboundPolicy(db: D1Database, policy: OutboundPolicy, userId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('outbound', ?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = ?1, updated_at = ?2, updated_by = ?3`,
    )
    .bind(JSON.stringify(policy), now(), userId)
    .run();
  cache = null;
}

/**
 * Admin-authored template HTML is trusted input, but it lands in every outgoing email,
 * so strip the things no signature needs and mail clients treat as hostile.
 */
export function cleanTemplateHtml(html: string): string {
  return html
    .replace(/<(script|style|iframe|object|embed|form|noscript|svg|math)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\/?(script|style|iframe|object|embed|form|base|meta|link|noscript|input|button|textarea|select)\b[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["'])\s*(?:javascript|vbscript|data:text):[^"']*\2/gi, '$1="#"')
    .trim();
}

// ---- Signatures ---------------------------------------------------------------

interface SenderRow {
  name: string;
  email: string;
  job_title: string | null;
  phone: string | null;
}

/** The company signature for this user sending from this mailbox, rendered; "" when none applies. */
export async function companySignature(
  db: D1Database,
  policy: OutboundPolicy,
  brand: Brand,
  opts: { userId: string | null; mailboxId: string; fromAddress?: string },
): Promise<string> {
  if (policy.signature.mode === "off") return "";
  const template = (policy.signature.mailboxTemplates[opts.mailboxId] || policy.signature.template).trim();
  if (!template) return "";
  const [user, mailbox] = await Promise.all([
    opts.userId ? db.prepare("SELECT name, email, job_title, phone FROM users WHERE id = ?").bind(opts.userId).first<SenderRow>() : null,
    db.prepare("SELECT address, display_name FROM mailboxes WHERE id = ?").bind(opts.mailboxId).first<{ address: string; display_name: string }>(),
  ]);
  return renderSignature(template, {
    name: user?.name ?? mailbox?.display_name ?? "",
    title: user?.job_title ?? "",
    email: opts.fromAddress || mailbox?.address || user?.email || "",
    phone: user?.phone ?? "",
    mailbox: mailbox?.display_name || mailbox?.address || "",
    company: brand.companyName,
  });
}

export const signatureMode = async (db: D1Database): Promise<SignatureMode> => (await getOutboundPolicy(db)).signature.mode;

/** Signature block for an API send that asked for one: the company signature when enforced, else the mailbox's. */
export async function apiSignature(
  db: D1Database,
  opts: { mailboxId: string; mailboxSignature: string; userId: string | null; fromAddress: string },
): Promise<string> {
  const policy = await getOutboundPolicy(db);
  if (policy.signature.mode === "enforce") {
    const sig = await companySignature(db, policy, await getBrand(db), opts);
    return sig ? signatureBlock(sig) : "";
  }
  const own = opts.mailboxSignature.trim();
  return own ? `<div style="margin-top:16px">${own}</div>` : "";
}

// ---- Disclaimer ---------------------------------------------------------------

const DISCLAIMER_MARKER = "data-io-disclaimer";

/** Already carries our disclaimer, e.g. a reply quoting an earlier message of ours. */
export const hasDisclaimer = (html: string) => new RegExp(`<div[^>]*\\s${DISCLAIMER_MARKER}=["']?1`, "i").test(html) || html.includes("<!--io-disclaimer-->");

export function disclaimerHtml(text: string): string {
  const body = escapeHtml(text.trim()).replace(/\r?\n/g, "<br>");
  return `<!--io-disclaimer--><div class="io_disclaimer" ${DISCLAIMER_MARKER}="1" style="margin-top:24px;padding-top:10px;border-top:1px solid #e5e7eb;font-size:11px;line-height:1.5;color:#6b7280">${body}</div>`;
}

export const disclaimerText = (text: string) => `\n\n--\n${text.trim()}`;

function insertBeforeBodyEnd(doc: string, fragment: string): string {
  const i = doc.search(/<\/body>/i);
  return i === -1 ? doc + fragment : doc.slice(0, i) + fragment + doc.slice(i);
}

// ---- Applying the policy at send time -------------------------------------------

export class PolicyBlockedError extends Error {
  constructor(public findings: DlpFinding[]) {
    super(`Not sent: your organization blocks sending ${findings.map((f) => f.label).join(", ")}. Remove it and try again.`);
  }
}

export interface OutboundInput {
  messageId: string;
  userId: string | null;
  mailboxId: string;
  fromAddress: string;
  subject: string;
  /** Editable body only (no quote). */
  bodyHtml: string;
  quoteHtml: string;
  /** Explicit text part from the API, if any. */
  apiText?: string;
  /** API sent a complete HTML document; it is not wrapped and the signature is the caller's business. */
  rawHtml: boolean;
  /** API messages choose their own signature (api-send applies the company one when enforced). */
  fromApi: boolean;
  recipients: Address[];
  filenames: string[];
}

export interface OutboundResult {
  html: string;
  /** Explicit text part, or null to derive it from html. */
  text: string | null;
  findings: DlpFinding[];
}

/** Recipients outside the company domains. */
export const externalRecipients = (recipients: Address[], brand: Brand) => recipients.filter((a) => isExternal(a.email, mailDomains(brand)));

/** Run DLP over what is about to leave. Pure apart from the policy it is given. */
export function evaluateDlp(policy: OutboundPolicy, brand: Brand, input: Pick<OutboundInput, "subject" | "bodyHtml" | "quoteHtml" | "apiText" | "recipients" | "filenames">) {
  // The quote is scanned too: forwarding a card number is as much a leak as typing it.
  const text = [htmlToText(input.bodyHtml + input.quoteHtml), input.apiText ?? ""].join("\n");
  return scanOutbound(policy.dlp, {
    subject: input.subject,
    text,
    filenames: input.filenames,
    hasExternal: externalRecipients(input.recipients, brand).length > 0,
  });
}

/** Early check for the API's scheduled sends; deliverMessage checks again when they go out. */
export async function dlpBlocks(db: D1Database, input: Parameters<typeof evaluateDlp>[2]): Promise<DlpFinding[]> {
  const [policy, brand] = await Promise.all([getOutboundPolicy(db), getBrand(db)]);
  return evaluateDlp(policy, brand, input).filter((f) => f.action === "block");
}

/**
 * The single choke point every outbound message (web, scheduled, API, MCP) passes
 * through in deliverMessage: re-check DLP server-side, add the enforced company
 * signature and the legal disclaimer. Throws PolicyBlockedError on a "block" finding.
 */
export async function applyOutboundPolicy(db: D1Database, brand: Brand, input: OutboundInput): Promise<OutboundResult> {
  const policy = await getOutboundPolicy(db);
  const findings = evaluateDlp(policy, brand, input);
  const blocks = findings.filter((f) => f.action === "block");
  if (blocks.length) {
    await logDlp(db, input, "dlp.blocked", blocks);
    throw new PolicyBlockedError(blocks);
  }
  if (findings.length) await logDlp(db, input, "dlp.warned_sent", findings);

  let body = input.bodyHtml;
  // Compose never puts the company signature in the editor when enforced, so always add it here.
  if (policy.signature.mode === "enforce" && !input.fromApi && !input.rawHtml) {
    const sig = await companySignature(db, policy, brand, input);
    if (sig) body += signatureBlock(sig);
  }
  let html = body + input.quoteHtml;
  let text: string | null = input.apiText ?? null;

  const d = policy.disclaimer;
  const wantsDisclaimer = d.enabled && d.text.trim() && (!d.externalOnly || externalRecipients(input.recipients, brand).length > 0);
  // Only the server-built quote counts: a marker typed into the body (or sent by an API
  // caller) must not be able to switch the disclaimer off.
  if (wantsDisclaimer && !hasDisclaimer(input.quoteHtml)) {
    html = input.rawHtml ? insertBeforeBodyEnd(html, disclaimerHtml(d.text)) : html + disclaimerHtml(d.text);
    if (text) text += disclaimerText(d.text);
  }
  return { html, text, findings };
}

/** Audit a DLP event. deliverMessage has no request context, so write the row directly. */
async function logDlp(db: D1Database, input: OutboundInput, action: string, findings: DlpFinding[]) {
  try {
    const actor = input.userId ? await db.prepare("SELECT id, email FROM users WHERE id = ?").bind(input.userId).first<{ id: string; email: string }>() : null;
    await db
      .prepare(
        `INSERT INTO audit_logs (id, actor_id, actor_email, action, target_type, target_id, ip, user_agent, meta, created_at)
         VALUES (?, ?, ?, ?, 'message', ?, NULL, NULL, ?, ?)`,
      )
      .bind(
        newId(),
        actor?.id ?? null,
        actor?.email ?? null,
        action,
        input.messageId,
        JSON.stringify({ rules: summarizeFindings(findings), mailboxId: input.mailboxId, via: input.fromApi ? "api" : "app" }),
        now(),
      )
      .run();
  } catch (err) {
    console.error("dlp audit failed", err);
  }
}
