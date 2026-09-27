import { z } from "zod";
import type { Address } from "@shared/types";
import type { Env } from "../env";
import { buildEml, type EmlAttachment } from "./eml";
import type { AttachmentRow, MessageRow } from "./messages";
import { ftsExpression, likeEscape, parseQuery } from "./search";
import { parseJson } from "./util";
import { ZipWriter } from "./zip";

/** Hard limits that keep one export inside a Worker's memory and CPU budget. */
export const EXPORT_MAX_MESSAGES = 500;
export const EXPORT_MAX_BYTES = 100 * 1024 * 1024;

const zDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-01-31")
  .refine((s) => !Number.isNaN(Date.parse(s)), "Not a valid date");

export const zCriteria = z.object({
  /** Search-box syntax (from: to: subject: has:attachment before: after: and free words). */
  q: z.string().trim().max(500).optional(),
  from: z.string().trim().max(200).optional(),
  to: z.string().trim().max(200).optional(),
  subject: z.string().trim().max(200).optional(),
  body: z.string().trim().max(300).optional(),
  /** Inclusive date range, YYYY-MM-DD (UTC). */
  after: zDay.optional(),
  before: zDay.optional(),
  hasAttachment: z.boolean().optional(),
  /** Empty or missing = every mailbox, including unrouted mail. */
  mailboxIds: z.array(z.string().min(1).max(64)).max(500).optional(),
});
export type Criteria = z.infer<typeof zCriteria>;

/**
 * WHERE clauses (for messages aliased `m`) matching the criteria. Every folder
 * is searched, Trash, Spam and drafts included: eDiscovery must see everything.
 */
export function discoveryWhere(c: Criteria): { where: string[]; args: unknown[] } {
  const p = parseQuery(c.q ?? "");
  const from = [...p.from, ...(c.from ? [c.from] : [])];
  const to = [...p.to, ...(c.to ? [c.to] : [])];
  const subject = [...p.subject, ...(c.subject ? [c.subject] : [])];
  const text = [...p.text, ...(c.body ? c.body.split(/\s+/) : [])];
  const where: string[] = [];
  const args: unknown[] = [];
  const like = (v: string) => `%${likeEscape(v)}%`;

  for (const f of from) {
    where.push("(m.from_addr LIKE ? ESCAPE '\\' OR m.from_name LIKE ? ESCAPE '\\')");
    args.push(like(f), like(f));
  }
  for (const t of to) {
    where.push("(m.to_json LIKE ? ESCAPE '\\' OR m.cc_json LIKE ? ESCAPE '\\' OR m.bcc_json LIKE ? ESCAPE '\\')");
    args.push(like(t), like(t), like(t));
  }
  for (const s of subject) {
    where.push("m.subject LIKE ? ESCAPE '\\'");
    args.push(like(s));
  }
  const fts = ftsExpression(text);
  if (fts) {
    where.push("m.id IN (SELECT message_id FROM messages_fts WHERE messages_fts MATCH ?)");
    args.push(fts);
  }
  if (c.hasAttachment || p.hasAttachment) where.push("m.has_attachments = 1");
  if (p.folder) {
    where.push("m.folder = ?");
    args.push(p.folder);
  }
  const after = c.after ? `${c.after}T00:00:00.000Z` : p.after;
  // "before" from the form is inclusive of that day.
  const before = c.before ? new Date(Date.parse(`${c.before}T00:00:00.000Z`) + 86_400_000).toISOString() : p.before;
  if (after) {
    where.push("m.date >= ?");
    args.push(after);
  }
  if (before) {
    where.push("m.date < ?");
    args.push(before);
  }
  if (c.mailboxIds?.length) {
    where.push("m.mailbox_id IN (SELECT value FROM json_each(?))");
    args.push(JSON.stringify(c.mailboxIds));
  }
  return { where, args };
}

export const whereSql = (w: string[]) => (w.length ? w.join(" AND ") : "1 = 1");

/** One row of the export manifest. Cells that a spreadsheet would run as formulas are neutralised. */
export function csvRow(cells: (string | number)[]): string {
  return cells
    .map((v) => {
      let s = String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(",");
}

/** A safe, unique-enough file name for one message inside the ZIP. */
export function emlFileName(index: number, date: string, subject: string): string {
  const slug = subject.replace(/[^\p{L}\p{N} _-]+/gu, "").trim().replace(/\s+/g, "-").slice(0, 60) || "no-subject";
  return `messages/${String(index + 1).padStart(4, "0")}_${date.slice(0, 10)}_${slug}.eml`;
}

const MANIFEST_HEADER = ["file", "message_id", "mailbox", "folder", "direction", "date", "from", "to", "cc", "subject", "attachments", "eml_bytes"];

interface ExportRow extends MessageRow {
  mailbox_address: string;
}

/**
 * Stream a ZIP of .eml files plus manifest.csv. Messages are loaded one at a
 * time; the archive stops early (and says so in the manifest) at EXPORT_MAX_BYTES.
 */
export function exportStream(env: Env, ids: string[]): ReadableStream<Uint8Array> {
  const zip = new ZipWriter();
  const enc = new TextEncoder();
  const manifest = [csvRow(MANIFEST_HEADER)];
  let i = 0;
  let stopped = false;
  let skipped = 0;
  let finished = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (i < ids.length && !stopped) {
          const id = ids[i];
          const m = await env.DB.prepare(
            "SELECT m.*, mb.address AS mailbox_address FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id WHERE m.id = ?",
          )
            .bind(id)
            .first<ExportRow>();
          if (!m) {
            skipped++;
            i++;
            continue;
          }
          const { results: atts } = await env.DB.prepare("SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at").bind(id).all<AttachmentRow>();
          const html = m.html_key ? await (await env.FILES.get(m.html_key))?.text() : null;
          const to = parseJson<Address[]>(m.to_json, []);
          const cc = parseJson<Address[]>(m.cc_json, []);
          const chunks = await buildEml(
            {
              id: m.id,
              mailbox: m.mailbox_address,
              folder: m.folder,
              from: { email: m.from_addr, name: m.from_name || undefined },
              to,
              cc,
              bcc: parseJson<Address[]>(m.bcc_json, []),
              replyTo: parseJson<Address[]>(m.reply_to_json, []),
              subject: m.subject,
              date: m.date,
              messageId: m.message_id_header,
              inReplyTo: m.in_reply_to,
              references: m.references_header,
              text: m.text_body,
              html: html ?? null,
            },
            atts.map<EmlAttachment>((a) => ({ filename: a.filename, contentType: a.content_type, contentId: a.content_id, inline: !!a.inline })),
            async (_a, k) => (await env.FILES.get(atts[k].r2_key))?.body ?? null,
          );
          const bytes = chunks.reduce((n, ch) => n + ch.length, 0);
          if (zip.size + bytes > EXPORT_MAX_BYTES) {
            stopped = true;
            break;
          }
          const name = emlFileName(i, m.date, m.subject);
          manifest.push(
            csvRow([
              name,
              m.id,
              m.mailbox_address,
              m.folder,
              m.direction,
              m.date,
              m.from_addr,
              to.map((a) => a.email).join("; "),
              cc.map((a) => a.email).join("; "),
              m.subject,
              atts.length,
              bytes,
            ]),
          );
          i++;
          for (const part of zip.file(name, chunks, new Date(m.date))) controller.enqueue(part);
          return; // one message per pull keeps memory to a single message
        }
        if (finished) return;
        finished = true;
        const notes: string[] = [];
        if (stopped) notes.push(`Export stopped at the ${EXPORT_MAX_BYTES / 1024 / 1024} MB limit: ${ids.length - i} message(s) not included. Narrow the search and export again.`);
        if (skipped) notes.push(`${skipped} message(s) were deleted before the export ran.`);
        const csv = [...manifest, ...notes.map((n) => csvRow([`# ${n}`]))].join("\r\n") + "\r\n";
        for (const part of zip.file("manifest.csv", [enc.encode(csv)])) controller.enqueue(part);
        controller.enqueue(zip.finish());
        controller.close();
      } catch (err) {
        console.error("ediscovery export failed", err);
        controller.error(err);
      }
    },
  });
}
