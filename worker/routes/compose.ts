import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Address } from "@shared/types";
import type { AppEnv, Env } from "../env";
import { assertFeature } from "../lib/features";
import { requireMailbox, requireMessage } from "../lib/access";
import { audit } from "../lib/audit";
import { attachmentKey, bodyKey, ftsStatements, purgeMessages, toAttachmentInfo, type AttachmentRow, type ComposeMeta, type MessageRow } from "../lib/messages";
import { forwardQuote, prefixSubject, replyQuote } from "../lib/quote";
import { deliverMessage, SendError } from "../lib/send";
import { htmlToText, makeSnippet, newId, normalizeSubject, now, parseJson } from "../lib/util";
import { parseBody, zAddress, zId } from "../lib/validate";
import { requestCtx } from "../lib/webhooks";

export const composeRoutes = new Hono<AppEnv>();

async function mailboxAddresses(db: D1Database, mailboxId: string): Promise<string[]> {
  const mb = await db.prepare("SELECT address FROM mailboxes WHERE id = ?").bind(mailboxId).first<{ address: string }>();
  const { results } = await db.prepare("SELECT address FROM mailbox_aliases WHERE mailbox_id = ?").bind(mailboxId).all<{ address: string }>();
  return [mb?.address, ...results.map((r) => r.address)].filter((x): x is string => !!x).map((x) => x.toLowerCase());
}

async function draftDto(env: Env, m: MessageRow) {
  const [{ results: atts }, htmlObj] = await Promise.all([
    env.DB.prepare("SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at").bind(m.id).all<AttachmentRow>(),
    m.html_key ? env.FILES.get(m.html_key) : null,
  ]);
  const meta = parseJson<ComposeMeta>(m.compose_meta, {});
  return {
    id: m.id,
    mailboxId: m.mailbox_id,
    fromAddress: m.from_addr,
    to: parseJson<Address[]>(m.to_json, []),
    cc: parseJson<Address[]>(m.cc_json, []),
    bcc: parseJson<Address[]>(m.bcc_json, []),
    replyTo: parseJson<Address[]>(m.reply_to_json, []),
    subject: m.subject,
    html: htmlObj ? await htmlObj.text() : "",
    attachments: atts.map(toAttachmentInfo),
    priority: m.priority,
    readReceipt: !!meta.readReceipt,
    quoteHtml: meta.quoteHtml ?? "",
    mode: meta.mode ?? "new",
    status: m.status,
    scheduledAt: m.scheduled_at,
    error: m.error,
    updatedAt: m.updated_at,
  };
}

const zDraft = z.object({
  id: zId.optional(),
  mailboxId: zId,
  fromAddress: z.string().trim().toLowerCase().optional(),
  to: z.array(zAddress).max(50).default([]),
  cc: z.array(zAddress).max(50).default([]),
  bcc: z.array(zAddress).max(50).default([]),
  replyTo: z.array(zAddress).max(5).default([]),
  subject: z.string().max(998).default(""),
  html: z.string().max(2_000_000).default(""),
  attachmentIds: z.array(zId).max(100).default([]),
  priority: z.enum(["normal", "high", "low"]).default("normal"),
  requestReadReceipt: z.boolean().optional(),
  keepQuote: z.boolean().default(true),
});

/** Create or update a draft (autosave). */
composeRoutes.post("/", async (c) => {
  const body = await parseBody(c, zDraft);
  const u = c.get("user");
  const db = c.env.DB;
  await requireMailbox(db, u, body.mailboxId, "editor");

  const addrs = await mailboxAddresses(db, body.mailboxId);
  const fromAddress = body.fromAddress && addrs.includes(body.fromAddress) ? body.fromAddress : addrs[0];
  const t = now();
  let existing: MessageRow | null = null;
  if (body.id) {
    existing = await requireMessage<MessageRow>(db, u, body.id, "editor");
    if (existing.folder !== "drafts") throw new HTTPException(409, { message: "This message has already been sent or scheduled." });
  }
  const id = existing?.id ?? newId();
  const meta: ComposeMeta = { ...parseJson<ComposeMeta>(existing?.compose_meta, {}), readReceipt: body.requestReadReceipt };
  if (!body.keepQuote) meta.quoteHtml = "";
  const key = bodyKey(body.mailboxId, id);
  await c.env.FILES.put(key, body.html, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
  if (existing?.html_key && existing.html_key !== key) await c.env.FILES.delete(existing.html_key);
  const text = htmlToText(body.html);

  // Attachments: claim new uploads, drop ones the user removed.
  const { results: current } = await db.prepare("SELECT id, r2_key FROM attachments WHERE message_id = ?").bind(id).all<{ id: string; r2_key: string }>();
  const keep = new Set(body.attachmentIds);
  const removed = current.filter((a) => !keep.has(a.id));
  const stmts: D1PreparedStatement[] = [];
  for (const a of body.attachmentIds) {
    stmts.push(
      db
        .prepare("UPDATE attachments SET message_id = ?, mailbox_id = ? WHERE id = ? AND (message_id = ? OR (message_id IS NULL AND uploaded_by = ?))")
        .bind(id, body.mailboxId, a, id, u.id),
    );
  }
  if (removed.length) {
    await c.env.FILES.delete(removed.map((r) => r.r2_key));
    stmts.push(db.prepare(`DELETE FROM attachments WHERE id IN (${removed.map(() => "?").join(",")})`).bind(...removed.map((r) => r.id)));
  }

  const values = [
    body.mailboxId,
    fromAddress,
    JSON.stringify(body.to),
    JSON.stringify(body.cc),
    JSON.stringify(body.bcc),
    JSON.stringify(body.replyTo),
    body.subject,
    normalizeSubject(body.subject),
    makeSnippet(text),
    text.slice(0, 100_000),
    key,
    body.priority,
    JSON.stringify(meta),
    body.attachmentIds.length ? 1 : 0,
    t,
    t,
  ];
  if (existing) {
    stmts.unshift(
      db
        .prepare(
          `UPDATE messages SET mailbox_id = ?, from_addr = ?, to_json = ?, cc_json = ?, bcc_json = ?, reply_to_json = ?, subject = ?,
             subject_norm = ?, snippet = ?, text_body = ?, html_key = ?, priority = ?, compose_meta = ?, has_attachments = ?, date = ?,
             updated_at = ?, status = 'draft', error = NULL WHERE id = ?`,
        )
        .bind(...values, id),
    );
  } else {
    stmts.unshift(
      db
        .prepare(
          `INSERT INTO messages (mailbox_id, from_addr, to_json, cc_json, bcc_json, reply_to_json, subject, subject_norm, snippet,
             text_body, html_key, priority, compose_meta, has_attachments, date, updated_at,
             id, thread_id, direction, folder, status, is_read, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'outbound', 'drafts', 'draft', 1, ?, ?)`,
        )
        .bind(...values, id, newId(), u.id, t),
    );
  }
  // Keep drafts searchable.
  stmts.push(...ftsStatements(db, { id, subject: body.subject, from: { email: fromAddress }, to: body.to, cc: body.cc, text }));
  await db.batch(stmts);
  const saved = await db.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first<MessageRow>();
  return c.json(await draftDto(c.env, saved!));
});

/** Start a reply / reply-all / forward as a new draft. */
composeRoutes.post("/from", async (c) => {
  const body = await parseBody(c, z.object({ sourceId: zId, mode: z.enum(["reply", "replyAll", "forward"]) }));
  const u = c.get("user");
  const db = c.env.DB;
  const src = await requireMessage<MessageRow>(db, u, body.sourceId, "editor");
  const own = new Set(await mailboxAddresses(db, src.mailbox_id));
  const srcTo = parseJson<Address[]>(src.to_json, []);
  const srcCc = parseJson<Address[]>(src.cc_json, []);
  const srcReplyTo = parseJson<Address[]>(src.reply_to_json, []);
  const from: Address = { email: src.from_addr, name: src.from_name || undefined };

  let to: Address[] = [];
  let cc: Address[] = [];
  if (body.mode !== "forward") {
    to = src.direction === "outbound" ? srcTo : srcReplyTo.length ? srcReplyTo : [from];
    if (body.mode === "replyAll") {
      const seen = new Set(to.map((a) => a.email));
      const extra = (src.direction === "outbound" ? [] : srcTo).concat(srcCc);
      cc = extra.filter((a) => !own.has(a.email) && !seen.has(a.email) && (seen.add(a.email), true));
    }
    to = to.filter((a) => !own.has(a.email) || src.direction === "outbound");
  }

  // Our own address that the original was sent to becomes the default From.
  const fromAddress =
    [...srcTo, ...srcCc].map((a) => a.email).find((e) => own.has(e)) ?? (src.direction === "outbound" ? src.from_addr : [...own][0]);

  const srcHtml = src.html_key ? await (await c.env.FILES.get(src.html_key))?.text() ?? null : null;
  const quoteHtml =
    body.mode === "forward"
      ? forwardQuote({ date: src.date, from, to: srcTo, cc: srcCc, subject: src.subject, html: srcHtml, text: src.text_body })
      : replyQuote({ date: src.date, from, html: srcHtml, text: src.text_body });

  const refs = [src.references_header, src.message_id_header].filter(Boolean).join(" ").split(/\s+/).filter(Boolean).slice(-10).join(" ");
  const id = newId();
  const t = now();
  const subject = prefixSubject(src.subject, body.mode === "forward" ? "Fwd" : "Re");
  const meta: ComposeMeta = { mode: body.mode, sourceId: src.id, quoteHtml };
  const key = bodyKey(src.mailbox_id, id);
  await c.env.FILES.put(key, "", { httpMetadata: { contentType: "text/html; charset=utf-8" } });

  // Forward all attachments; replies keep inline images so the quoted content still renders.
  const { results: srcAtts } = await db.prepare("SELECT * FROM attachments WHERE message_id = ?").bind(src.id).all<AttachmentRow>();
  const copies = srcAtts.filter((a) => body.mode === "forward" || a.inline);
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO messages (id, mailbox_id, thread_id, direction, folder, status, from_addr, to_json, cc_json, subject, subject_norm,
           html_key, in_reply_to, references_header, is_read, has_attachments, compose_meta, created_by, date, created_at, updated_at)
         VALUES (?, ?, ?, 'outbound', 'drafts', 'draft', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        src.mailbox_id,
        src.thread_id,
        fromAddress,
        JSON.stringify(to),
        JSON.stringify(cc),
        subject,
        normalizeSubject(subject),
        key,
        body.mode === "forward" ? null : src.message_id_header,
        body.mode === "forward" ? null : refs || null,
        copies.some((a) => !a.inline) ? 1 : 0,
        JSON.stringify(meta),
        u.id,
        t,
        t,
        t,
      ),
  ];
  for (const a of copies) {
    const attId = newId();
    const newKey = attachmentKey(src.mailbox_id, attId);
    const obj = await c.env.FILES.get(a.r2_key);
    if (!obj) continue;
    await c.env.FILES.put(newKey, obj.body, { httpMetadata: { contentType: a.content_type } });
    stmts.push(
      db
        .prepare(
          `INSERT INTO attachments (id, message_id, mailbox_id, filename, content_type, size, r2_key, content_id, inline, uploaded_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(attId, id, src.mailbox_id, a.filename, a.content_type, a.size, newKey, a.content_id, a.inline, u.id, t),
    );
  }
  await db.batch(stmts);
  const saved = await db.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first<MessageRow>();
  return c.json(await draftDto(c.env, saved!), 201);
});

composeRoutes.get("/:id", async (c) => {
  const m = await requireMessage<MessageRow>(c.env.DB, c.get("user"), c.req.param("id"), "editor");
  if (m.folder !== "drafts" && m.folder !== "scheduled") throw new HTTPException(404, { message: "Draft not found" });
  return c.json(await draftDto(c.env, m));
});

composeRoutes.delete("/:id", async (c) => {
  const m = await requireMessage<MessageRow>(c.env.DB, c.get("user"), c.req.param("id"), "editor");
  if (m.folder !== "drafts") throw new HTTPException(409, { message: "Only drafts can be discarded." });
  await purgeMessages(c.env.DB, c.env.FILES, [m.id]);
  return c.json({ ok: true });
});

composeRoutes.post("/:id/send", async (c) => {
  const body = await parseBody(c, z.object({ scheduledAt: z.string().datetime({ offset: true }).nullish() }));
  const u = c.get("user");
  const m = await requireMessage<MessageRow>(c.env.DB, u, c.req.param("id"), "editor");
  if (m.folder !== "drafts") throw new HTTPException(409, { message: "This message has already been sent or scheduled." });
  const to = parseJson<Address[]>(m.to_json, []).length + parseJson<Address[]>(m.cc_json, []).length + parseJson<Address[]>(m.bcc_json, []).length;
  if (!to) throw new HTTPException(400, { message: "Add at least one recipient." });

  if (body.scheduledAt) {
    await assertFeature(c, "scheduledSend");
    const at = Date.parse(body.scheduledAt);
    if (at < Date.now() + 30_000) throw new HTTPException(400, { message: "Pick a time in the future." });
    if (at > Date.now() + 365 * 86_400_000) throw new HTTPException(400, { message: "You can schedule up to a year ahead." });
    const iso = new Date(at).toISOString();
    await c.env.DB.prepare("UPDATE messages SET status = 'scheduled', folder = 'scheduled', scheduled_at = ?, error = NULL, updated_at = ? WHERE id = ?")
      .bind(iso, now(), m.id)
      .run();
    await audit(c, { action: "message.scheduled", targetType: "message", targetId: m.id, meta: { mailboxId: m.mailbox_id, scheduledAt: iso } });
    return c.json({ ok: true, scheduled: true, scheduledAt: iso });
  }

  // Claim the draft so a double-click can't send twice.
  const claim = await c.env.DB.prepare("UPDATE messages SET status = 'queued', updated_at = ? WHERE id = ? AND status IN ('draft','failed')")
    .bind(now(), m.id)
    .run();
  if (!claim.meta.changes) throw new HTTPException(409, { message: "This message is already being sent." });
  try {
    const sent = await deliverMessage(c.env, m.id, requestCtx(c));
    await audit(c, { action: "message.sent", targetType: "message", targetId: m.id, meta: { mailboxId: m.mailbox_id, recipients: to } });
    return c.json({ ok: true, id: sent.id, status: sent.status });
  } catch (err) {
    if (err instanceof SendError) {
      if (err.status !== 502) {
        await c.env.DB.prepare("UPDATE messages SET status = 'draft' WHERE id = ? AND status = 'queued'").bind(m.id).run();
      }
      throw new HTTPException(err.status as 400, { message: err.message });
    }
    throw err;
  }
});

/** Cancel a scheduled send and turn it back into a draft. */
composeRoutes.post("/:id/unschedule", async (c) => {
  const m = await requireMessage<MessageRow>(c.env.DB, c.get("user"), c.req.param("id"), "editor");
  const res = await c.env.DB.prepare(
    "UPDATE messages SET status = 'draft', folder = 'drafts', scheduled_at = NULL, updated_at = ? WHERE id = ? AND status = 'scheduled'",
  )
    .bind(now(), m.id)
    .run();
  if (!res.meta.changes) throw new HTTPException(409, { message: "This message is no longer scheduled." });
  await audit(c, { action: "message.unscheduled", targetType: "message", targetId: m.id });
  return c.json({ ok: true });
});
