import type { Address } from "@shared/types";

/**
 * Rebuild an RFC 5322 message (.eml) from what we store: header fields from the
 * messages row, the HTML body from R2, attachments as base64 MIME parts. Used by
 * eDiscovery exports; the provider's raw source isn't kept.
 */

export interface EmlMessage {
  id: string;
  mailbox: string;
  folder: string;
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address[];
  subject: string;
  date: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  text: string;
  html: string | null;
}

export interface EmlAttachment {
  filename: string;
  contentType: string;
  contentId: string | null;
  inline: boolean;
}

/** Attachment bytes: whole, streamed, or null if the object is gone. */
export type AttachmentData = Uint8Array | AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | null;

const enc = new TextEncoder();
const CRLF = "\r\n";

/** Header values never carry line breaks (header injection). */
export const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, " ").trim();

const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** RFC 2047 encoded-words for non-ASCII text, split so each word stays under 75 chars. */
export function encodeWord(s: string): string {
  s = oneLine(s);
  if (isAscii(s)) return s;
  const words: string[] = [];
  let cur = "";
  for (const ch of s) {
    if (enc.encode(cur + ch).length > 45) {
      words.push(cur);
      cur = "";
    }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words.map((w) => `=?UTF-8?B?${b64(enc.encode(w))}?=`).join(`${CRLF} `);
}

export function formatAddress(a: Address): string {
  const email = oneLine(a.email);
  const name = a.name ? oneLine(a.name) : "";
  if (!name) return email;
  return `${isAscii(name) ? `"${name.replace(/["\\]/g, "\\$&")}"` : encodeWord(name)} <${email}>`;
}

export const formatAddressList = (list: Address[]) => list.map(formatAddress).join(`,${CRLF} `);

/** RFC 5322 date, e.g. "Thu, 01 Oct 2026 12:00:00 +0000". */
export function rfc2822Date(iso: string): string {
  const d = new Date(iso);
  return (Number.isNaN(d.getTime()) ? new Date(0) : d).toUTCString().replace(/GMT$/, "+0000");
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x2000) s += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  return btoa(s);
}

/** Base64 wrapped at 76 characters, every line ending in CRLF. */
export function base64Lines(bytes: Uint8Array): string {
  if (!bytes.length) return "";
  const s = b64(bytes);
  let out = "";
  for (let i = 0; i < s.length; i += 76) out += s.slice(i, i + 76) + CRLF;
  return out;
}

/** Encodes a byte stream to wrapped base64 without holding the whole input. */
export class Base64Stream {
  private rest = new Uint8Array(0);
  push(b: Uint8Array): string {
    const all = new Uint8Array(this.rest.length + b.length);
    all.set(this.rest);
    all.set(b, this.rest.length);
    const n = all.length - (all.length % 57);
    this.rest = all.slice(n);
    return base64Lines(all.subarray(0, n));
  }
  end(): string {
    const out = base64Lines(this.rest);
    this.rest = new Uint8Array(0);
    return out;
  }
}

/** RFC 2231 filename parameter, with an ASCII fallback for old readers. */
export function filenameParams(name: string): string {
  const clean = oneLine(name) || "attachment";
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const ext = encodeURIComponent(clean).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  // The extended form goes first: readers that understand both take the first one they see.
  return isAscii(clean) ? `filename="${ascii}"` : `filename*=UTF-8''${ext};${CRLF} filename="${ascii}"`;
}

type Part =
  | { kind: "leaf"; headers: string[]; body: () => AsyncGenerator<string> }
  | { kind: "multi"; subtype: "mixed" | "alternative" | "related"; children: Part[] };

const boundary = () => `----=_IO_${crypto.randomUUID().replace(/-/g, "")}`;

async function* streamOf(data: AttachmentData): AsyncGenerator<Uint8Array> {
  if (!data) return;
  if (data instanceof Uint8Array) {
    yield data;
    return;
  }
  if (data instanceof ReadableStream) {
    const reader = data.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  }
  for await (const ch of data as AsyncIterable<Uint8Array>) yield ch;
}

function textPart(type: "plain" | "html", body: string): Part {
  return {
    kind: "leaf",
    headers: [`Content-Type: text/${type}; charset=utf-8`, "Content-Transfer-Encoding: base64"],
    body: async function* () {
      yield base64Lines(enc.encode(body));
    },
  };
}

function attachmentPart(a: EmlAttachment, data: () => Promise<AttachmentData>): Part {
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(a.contentType) ? a.contentType : "application/octet-stream";
  const headers = [`Content-Type: ${type}`, "Content-Transfer-Encoding: base64", `Content-Disposition: ${a.inline ? "inline" : "attachment"}; ${filenameParams(a.filename)}`];
  if (a.contentId) headers.push(`Content-ID: <${oneLine(a.contentId).replace(/^<|>$/g, "")}>`);
  return {
    kind: "leaf",
    headers,
    body: async function* () {
      const enc64 = new Base64Stream();
      for await (const ch of streamOf(await data())) {
        const s = enc64.push(ch);
        if (s) yield s;
      }
      yield enc64.end();
    },
  };
}

async function* writePart(p: Part, out: { headersDone?: boolean } = {}): AsyncGenerator<string> {
  if (p.kind === "leaf") {
    yield p.headers.join(CRLF) + CRLF + CRLF;
    yield* p.body();
    return;
  }
  const b = boundary();
  yield `Content-Type: multipart/${p.subtype};${CRLF} boundary="${b}"${CRLF}${CRLF}`;
  if (!out.headersDone) yield `This is a multi-part message in MIME format.${CRLF}`;
  for (const child of p.children) {
    yield `${CRLF}--${b}${CRLF}`;
    yield* writePart(child, { headersDone: true });
  }
  yield `${CRLF}--${b}--${CRLF}`;
}

/** The message's header block (without the Content-Type of its body). */
export function emlHeaders(m: EmlMessage): string[] {
  const h = [`Date: ${rfc2822Date(m.date)}`, `From: ${formatAddress(m.from)}`];
  if (m.to.length) h.push(`To: ${formatAddressList(m.to)}`);
  if (m.cc.length) h.push(`Cc: ${formatAddressList(m.cc)}`);
  if (m.bcc.length) h.push(`Bcc: ${formatAddressList(m.bcc)}`);
  if (m.replyTo.length) h.push(`Reply-To: ${formatAddressList(m.replyTo)}`);
  h.push(`Subject: ${encodeWord(m.subject)}`);
  if (m.messageId) h.push(`Message-ID: ${oneLine(m.messageId)}`);
  if (m.inReplyTo) h.push(`In-Reply-To: ${oneLine(m.inReplyTo)}`);
  if (m.references) h.push(`References: ${oneLine(m.references)}`);
  h.push(`X-InboxOS-Id: ${oneLine(m.id)}`, `X-InboxOS-Mailbox: ${oneLine(m.mailbox)}`, `X-InboxOS-Folder: ${oneLine(m.folder)}`, "MIME-Version: 1.0");
  return h;
}

/**
 * Build the .eml as byte chunks. `read` fetches one attachment's bytes when its
 * part is written, so only one attachment is in flight at a time.
 */
export async function buildEml(m: EmlMessage, atts: EmlAttachment[], read: (a: EmlAttachment, i: number) => Promise<AttachmentData>): Promise<Uint8Array[]> {
  let body: Part = m.html
    ? m.text.trim()
      ? { kind: "multi", subtype: "alternative", children: [textPart("plain", m.text), textPart("html", m.html)] }
      : textPart("html", m.html)
    : textPart("plain", m.text);
  const parts = atts.map((a, i) => ({ a, part: attachmentPart(a, () => read(a, i)) }));
  const inline = parts.filter((p) => p.a.inline && p.a.contentId && m.html);
  const regular = parts.filter((p) => !inline.includes(p));
  if (inline.length) body = { kind: "multi", subtype: "related", children: [body, ...inline.map((p) => p.part)] };
  if (regular.length) body = { kind: "multi", subtype: "mixed", children: [body, ...regular.map((p) => p.part)] };

  const chunks: Uint8Array[] = [enc.encode(emlHeaders(m).join(CRLF) + CRLF)];
  for await (const s of writePart(body)) if (s) chunks.push(enc.encode(s));
  return chunks;
}
