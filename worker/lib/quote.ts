import type { Address } from "@shared/types";
import { escapeHtml, formatAddress, textToHtml } from "./util";

/** Make third-party HTML safe enough to embed as a quoted block in an outgoing email. */
export function cleanForQuote(html: string): string {
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  return body
    .replace(/<(script|iframe|object|embed|form|noscript)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\/?(script|iframe|object|embed|form|base|meta|link|noscript)\b[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });

const list = (a: Address[]) => a.map((x) => escapeHtml(formatAddress(x))).join(", ");

export function replyQuote(src: { date: string; from: Address; html: string | null; text: string }): string {
  const content = src.html ? cleanForQuote(src.html) : textToHtml(src.text);
  return `<br><div class="io_quote"><div dir="ltr">On ${escapeHtml(fmtDate(src.date))}, ${escapeHtml(formatAddress(src.from))} wrote:<br></div><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${content}</blockquote></div>`;
}

export function forwardQuote(src: { date: string; from: Address; to: Address[]; cc: Address[]; subject: string; html: string | null; text: string }): string {
  const content = src.html ? cleanForQuote(src.html) : textToHtml(src.text);
  return `<br><div class="io_quote"><div dir="ltr">---------- Forwarded message ---------<br>From: ${escapeHtml(formatAddress(src.from))}<br>Date: ${escapeHtml(fmtDate(src.date))}<br>Subject: ${escapeHtml(src.subject)}<br>To: ${list(src.to)}<br>${src.cc.length ? `Cc: ${list(src.cc)}<br>` : ""}</div><br>${content}</div>`;
}

export function prefixSubject(subject: string, prefix: "Re" | "Fwd"): string {
  const re = prefix === "Re" ? /^\s*re\s*:/i : /^\s*(fwd?|fw)\s*:/i;
  return re.test(subject) ? subject : `${prefix}: ${subject}`;
}
