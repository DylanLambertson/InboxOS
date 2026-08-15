import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, SessionUser } from "../env";
import { requireMailbox } from "../lib/access";
import { attachmentKey, toAttachmentInfo, type AttachmentRow } from "../lib/messages";
import { getPolicy } from "../lib/settings";
import { newId, now, sanitizeFilename } from "../lib/util";

export const attachmentRoutes = new Hono<AppEnv>();

/** Types that are safe to render inline in the browser. Everything else downloads. */
const INLINE_SAFE = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|application\/pdf|text\/plain|audio\/|video\/)/i;

async function loadAttachment(db: D1Database, user: SessionUser, id: string, min: "viewer" | "editor") {
  const a = await db.prepare("SELECT * FROM attachments WHERE id = ?").bind(id).first<AttachmentRow>();
  if (!a) throw new HTTPException(404, { message: "Attachment not found" });
  if (!a.message_id) {
    // Unsent upload: only the uploader can see it.
    if (a.uploaded_by !== user.id) throw new HTTPException(404, { message: "Attachment not found" });
    return a;
  }
  await requireMailbox(db, user, a.mailbox_id, min);
  return a;
}

attachmentRoutes.post("/", async (c) => {
  const u = c.get("user");
  const form = await c.req.formData();
  const file = form.get("file");
  const mailboxId = String(form.get("mailboxId") ?? "");
  const inline = form.get("inline") === "1";
  if (!(file instanceof File)) throw new HTTPException(400, { message: "No file uploaded" });
  await requireMailbox(c.env.DB, u, mailboxId, "editor");
  const policy = await getPolicy(c.env.DB);
  if (file.size > policy.maxAttachmentMb * 1024 * 1024) {
    throw new HTTPException(413, { message: `Files must be under ${policy.maxAttachmentMb} MB` });
  }
  if (inline && !/^image\//.test(file.type)) throw new HTTPException(400, { message: "Only images can be inserted inline" });

  const id = newId();
  const key = attachmentKey(mailboxId, id);
  const contentType = file.type || "application/octet-stream";
  await c.env.FILES.put(key, file.stream(), { httpMetadata: { contentType } });
  const row: AttachmentRow = {
    id,
    message_id: null,
    mailbox_id: mailboxId,
    filename: sanitizeFilename(file.name),
    content_type: contentType,
    size: file.size,
    r2_key: key,
    content_id: inline ? `${id}@inline` : null,
    inline: inline ? 1 : 0,
    uploaded_by: u.id,
    created_at: now(),
  };
  await c.env.DB.prepare(
    `INSERT INTO attachments (id, message_id, mailbox_id, filename, content_type, size, r2_key, content_id, inline, uploaded_by, created_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, mailboxId, row.filename, row.content_type, row.size, key, row.content_id, row.inline, u.id, row.created_at)
    .run();
  return c.json(toAttachmentInfo(row), 201);
});

async function serve(c: Context<AppEnv>, forceDownload: boolean) {
  const a = await loadAttachment(c.env.DB, c.get("user"), c.req.param("id")!, "viewer");
  const obj = await c.env.FILES.get(a.r2_key);
  if (!obj) throw new HTTPException(404, { message: "File is missing from storage" });
  const inline = !forceDownload && c.req.query("download") !== "1" && INLINE_SAFE.test(a.content_type);
  const encoded = encodeURIComponent(a.filename);
  return new Response(obj.body, {
    headers: {
      "Content-Type": inline ? a.content_type : "application/octet-stream",
      "Content-Length": String(a.size),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${a.filename.replace(/"/g, "")}"; filename*=UTF-8''${encoded}`,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    },
  });
}

attachmentRoutes.get("/:id", (c) => serve(c, false));
attachmentRoutes.get("/:id/raw", (c) => serve(c, false));

attachmentRoutes.delete("/:id", async (c) => {
  const u = c.get("user");
  const a = await loadAttachment(c.env.DB, u, c.req.param("id"), "editor");
  if (a.message_id) {
    const m = await c.env.DB.prepare("SELECT folder FROM messages WHERE id = ?").bind(a.message_id).first<{ folder: string }>();
    if (m?.folder !== "drafts") throw new HTTPException(409, { message: "Attachments on sent messages can't be removed." });
  }
  await c.env.FILES.delete(a.r2_key);
  await c.env.DB.prepare("DELETE FROM attachments WHERE id = ?").bind(a.id).run();
  return c.json({ ok: true });
});
