import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Address } from "@shared/types";
import { FOLDERS } from "@shared/types";
import type { AppEnv } from "../env";
import { requireFeature } from "../lib/features";
import { allowedMailboxes, deleteContact, getContact, getMessage, getThread, listMessages, MESSAGE_ACTIONS, messageAction, saveContacts, searchContacts, sendingStatus } from "../lib/api-ops";
import { apiSend } from "../lib/api-send";
import { mailboxAllowed, requireApiKey, requireScope } from "../lib/apikeys";
import type { AttachmentRow } from "../lib/messages";
import { clampInt, parseAddress } from "../lib/util";
import { attachmentResponse } from "./attachments";
import { parseBody, zEmail, zId } from "../lib/validate";

/**
 * Public REST API for other services, authenticated with `Authorization: Bearer <API key>`.
 * Keys are issued in Admin → API & MCP.
 */
export const apiV1Routes = new Hono<AppEnv>();
apiV1Routes.use("*", requireFeature("api"));
apiV1Routes.use("*", requireApiKey);

/** Accepts "Name <a@b>", "a@b", a comma-separated string, or an array of either / {email, name}. */
export const zRecipients = z
  .union([z.string(), z.array(z.union([z.string(), z.object({ email: z.string(), name: z.string().optional() })])).max(50)])
  .transform((v, ctx) => {
    const items = typeof v === "string" ? v.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).filter((s) => s.trim()) : v;
    const out: Address[] = [];
    for (const it of items) {
      const a = typeof it === "string" ? parseAddress(it) : parseAddress(it.email) && { email: it.email.trim().toLowerCase(), name: it.name?.trim() || undefined };
      if (!a) {
        ctx.addIssue({ code: "custom", message: `"${typeof it === "string" ? it : it.email}" isn't a valid email address` });
        return z.NEVER;
      }
      out.push(a);
    }
    return out;
  });

const zSend = z.object({
  from: z.string().max(400).optional(),
  mailbox_id: zId.optional(),
  to: zRecipients.default([]),
  cc: zRecipients.optional(),
  bcc: zRecipients.optional(),
  reply_to: zRecipients.optional(),
  subject: z.string().max(998).optional(),
  html: z.string().max(2_000_000).optional(),
  text: z.string().max(500_000).optional(),
  reply_to_message_id: zId.optional(),
  scheduled_at: z.string().datetime({ offset: true }).nullish(),
  draft: z.boolean().default(false),
  outreach: z.boolean().default(false),
  signature: z.boolean().default(false),
});

apiV1Routes.post("/send", async (c) => {
  const b = await parseBody(c, zSend);
  const res = await apiSend(c, {
    from: b.from,
    mailboxId: b.mailbox_id,
    to: b.to,
    cc: b.cc,
    bcc: b.bcc,
    replyTo: b.reply_to,
    subject: b.subject,
    html: b.html,
    text: b.text,
    replyToMessageId: b.reply_to_message_id,
    scheduledAt: b.scheduled_at,
    mode: b.draft ? "draft" : "send",
    outreach: b.outreach,
    signature: b.signature,
  });
  return c.json(res);
});

apiV1Routes.get("/status", async (c) => c.json(await sendingStatus(c)));
apiV1Routes.get("/mailboxes", async (c) => c.json(await allowedMailboxes(c)));

apiV1Routes.get("/contacts", async (c) =>
  c.json(await searchContacts(c, { query: c.req.query("q"), tag: c.req.query("tag"), savedOnly: c.req.query("saved") === "1", limit: clampInt(c.req.query("limit"), 1, 200, 50) })),
);

export const zContactInput = z.object({
  email: zEmail,
  name: z.string().trim().max(200).optional(),
  company: z.string().trim().max(200).optional(),
  title: z.string().trim().max(200).optional(),
  website: z.string().trim().max(400).optional(),
  notes: z.string().max(5000).optional(),
  tags: z.array(z.string().trim().max(40)).max(30).optional(),
});

apiV1Routes.post("/contacts", async (c) => {
  const b = await parseBody(c, z.union([z.object({ contacts: z.array(zContactInput).min(1).max(100) }), zContactInput]));
  return c.json(await saveContacts(c, "contacts" in b ? b.contacts : [b]));
});

apiV1Routes.get("/contacts/:email", async (c) => c.json(await getContact(c, c.req.param("email").toLowerCase())));
apiV1Routes.delete("/contacts/:email", async (c) => c.json(await deleteContact(c, c.req.param("email").toLowerCase())));

apiV1Routes.get("/messages", async (c) => {
  const folder = c.req.query("folder");
  return c.json(
    await listMessages(c, {
      mailbox: c.req.query("mailbox"),
      folder: (FOLDERS as readonly string[]).includes(folder ?? "") ? (folder as (typeof FOLDERS)[number]) : "inbox",
      query: c.req.query("q"),
      unreadOnly: c.req.query("unread") === "1",
      since: c.req.query("since"),
      limit: clampInt(c.req.query("limit"), 1, 100, 25),
    }),
  );
});

apiV1Routes.get("/messages/:id/thread", async (c) => c.json(await getThread(c, c.req.param("id"))));
apiV1Routes.get("/messages/:id", async (c) => c.json(await getMessage(c, c.req.param("id"))));

/** Stream a message attachment from R2, scoped to the key's allowed mailboxes. `?download=1` forces a download. */
apiV1Routes.get("/attachments/:id", async (c) => {
  requireScope(c.get("apiKey"), "read");
  const a = await c.env.DB.prepare("SELECT * FROM attachments WHERE id = ?").bind(c.req.param("id")).first<AttachmentRow>();
  if (!a || !a.message_id || !mailboxAllowed(c, a.mailbox_id)) throw new HTTPException(404, { message: "Attachment not found" });
  return attachmentResponse(c.env.FILES, a, c.req.query("download") === "1");
});

const zMessageAction = z.object({
  ids: z.array(zId).min(1).max(500),
  action: z.enum(MESSAGE_ACTIONS),
  /** Apply to every message in each one's conversation. */
  thread: z.boolean().optional(),
});

apiV1Routes.post("/messages/actions", async (c) => {
  const b = await parseBody(c, zMessageAction);
  return c.json(await messageAction(c, b));
});
