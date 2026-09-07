import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { FOLDERS } from "@shared/types";
import type { AppEnv } from "../env";
import { allowedMailboxes, deleteContact, getContact, getThread, listMessages, saveContacts, searchContacts, sendingStatus, suppress } from "../lib/api-ops";
import { apiSend } from "../lib/api-send";
import { requireApiKey } from "../lib/apikeys";
import { zContactInput, zRecipients } from "./api-v1";

/**
 * Model Context Protocol server (Streamable HTTP, stateless, JSON responses) so MCP clients
 * can manage contacts and send email. Connect a client to `${APP_URL}/mcp` with an API key
 * as a Bearer token, or to `${APP_URL}/mcp/<key>` for clients that can't send headers.
 */
export const mcpRoutes = new Hono<AppEnv>();

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `InboxOS: the Acme team's email platform. You can manage contacts and send email from the team's mailboxes.
Outreach guidelines:
- Before writing to someone, call get_contact to read their notes and any past conversation, and write an email specific to them. Never send one generic text to many people.
- One recipient per email. send_email adds an unsubscribe link automatically for outreach; keep it.
- Never email anyone marked do-not-email. If someone asks to stop, call mark_do_not_email right away.
- Keep cold emails short and plain, with one clear ask. No attachments, no misleading subject lines.
- When the user wants to review first, or you're unsure, use create_draft: a teammate can edit and send it from Drafts.
- Check get_status for remaining sending quota before a batch, and save what you learn about a lead with save_contacts (notes, tags such as "lead", "contacted", "replied").
- To follow up or answer a reply, pass reply_to_message_id so it stays in the same conversation.`;

const zMessageFields = {
  from: z.string().optional().describe('Mailbox address to send from, optionally with a sender name: "Dylan at Acme <dylan@example.com>". Optional when replying or when the key has one mailbox.'),
  to: zRecipients.optional().describe('Recipient: "Jo Rivera <jo@acme.com>". Optional when replying (defaults to the other person).'),
  subject: z.string().max(998).optional().describe("Subject. Optional when replying (defaults to Re: original)."),
  body: z.string().max(100_000).optional().describe("Plain-text body. Blank lines separate paragraphs; links become clickable."),
  html: z.string().max(500_000).optional().describe("HTML body, instead of body. Rarely needed."),
  reply_to_message_id: z.string().optional().describe("Id of a message to reply to, from list_messages or get_thread."),
  outreach: z.boolean().default(true).describe("Adds an unsubscribe link and honours the do-not-email list. Leave on for cold and follow-up emails."),
  signature: z.boolean().default(true).describe("Append the mailbox's signature."),
};

interface Tool {
  description: string;
  input: z.ZodObject;
  annotations?: Record<string, boolean | string>;
  run: (c: Context<AppEnv>, args: any) => Promise<unknown>;
}

const sendArgs = (a: any, mode: "send" | "draft") => ({
  from: a.from,
  to: a.to ?? [],
  subject: a.subject,
  text: a.body,
  html: a.html,
  replyToMessageId: a.reply_to_message_id,
  scheduledAt: a.schedule_at,
  mode,
  outreach: a.outreach,
  signature: a.signature,
});

const TOOLS: Record<string, Tool> = {
  get_status: {
    description: "Sending quota used and remaining, the mailboxes you can send from, and the size of the do-not-email list.",
    input: z.object({}),
    annotations: { readOnlyHint: true },
    run: (c) => sendingStatus(c),
  },
  list_mailboxes: {
    description: "Mailboxes (sender addresses) this connection may send from and read.",
    input: z.object({}),
    annotations: { readOnlyHint: true },
    run: (c) => allowedMailboxes(c),
  },
  search_contacts: {
    description: "Search the address book by name, email, company or notes, optionally filtered by tag. Includes each contact's do-not-email status.",
    input: z.object({
      query: z.string().optional(),
      tag: z.string().optional().describe('e.g. "lead"'),
      saved_only: z.boolean().default(false).describe("Only contacts someone saved, not ones collected automatically from mail."),
      limit: z.number().int().min(1).max(200).default(50),
    }),
    annotations: { readOnlyHint: true },
    run: (c, a) => searchContacts(c, { query: a.query, tag: a.tag, savedOnly: a.saved_only, limit: a.limit }),
  },
  get_contact: {
    description: "One contact's details, do-not-email status, and the last 20 emails exchanged with them. Read this before writing to someone.",
    input: z.object({ email: z.string().email() }),
    annotations: { readOnlyHint: true },
    run: (c, a) => getContact(c, a.email.toLowerCase()),
  },
  save_contacts: {
    description: "Create or update up to 100 contacts. Only the fields you pass change; tags replace the existing tags.",
    input: z.object({ contacts: z.array(zContactInput).min(1).max(100) }),
    run: (c, a) => saveContacts(c, a.contacts),
  },
  delete_contact: {
    description: "Delete a contact from the address book. To stop emailing someone, use mark_do_not_email instead.",
    input: z.object({ email: z.string().email() }),
    annotations: { destructiveHint: true },
    run: (c, a) => deleteContact(c, a.email.toLowerCase()),
  },
  mark_do_not_email: {
    description: "Add an address to the do-not-email list (they asked to stop, or aren't a fit). Outreach to them is then refused.",
    input: z.object({
      email: z.string().email(),
      reason: z.enum(["unsubscribed", "manual"]).default("manual").describe('"unsubscribed" when they asked to stop.'),
      note: z.string().max(500).optional(),
    }),
    run: (c, a) => suppress(c, a.email.toLowerCase(), a.reason, a.note),
  },
  send_email: {
    description: "Send an email now (or schedule it) from a team mailbox. It appears in that mailbox's Sent folder, and replies arrive in its inbox.",
    input: z.object({
      ...zMessageFields,
      schedule_at: z.string().datetime({ offset: true }).optional().describe("Send later, ISO 8601 with timezone, e.g. 2026-10-01T09:00:00-04:00."),
    }),
    annotations: { destructiveHint: false, openWorldHint: true },
    run: (c, a) => apiSend(c, sendArgs(a, "send")),
  },
  create_draft: {
    description: "Write an email into a mailbox's Drafts without sending it, so a teammate can review, edit and send it.",
    input: z.object(zMessageFields),
    run: (c, a) => apiSend(c, sendArgs(a, "draft")),
  },
  list_messages: {
    description: "List recent messages in a folder (default: inbox) across your mailboxes, newest first. Use it to find replies to outreach.",
    input: z.object({
      mailbox: z.string().optional().describe("Mailbox address or id. Default: all."),
      folder: z.enum(FOLDERS).default("inbox"),
      query: z.string().optional().describe("Matches sender, recipient, subject or preview text."),
      unread_only: z.boolean().default(false),
      since: z.string().optional().describe("Only messages on or after this ISO date."),
      limit: z.number().int().min(1).max(100).default(25),
    }),
    annotations: { readOnlyHint: true },
    run: (c, a) => listMessages(c, { mailbox: a.mailbox, folder: a.folder, query: a.query, unreadOnly: a.unread_only, since: a.since, limit: a.limit }),
  },
  get_thread: {
    description: "The whole conversation a message belongs to, oldest first, with plain-text bodies and delivery status.",
    input: z.object({ message_id: z.string() }),
    annotations: { readOnlyHint: true },
    run: (c, a) => getThread(c, a.message_id),
  },
};

const toolList = Object.entries(TOOLS).map(([name, t]) => {
  const { $schema: _, ...inputSchema } = z.toJSONSchema(t.input, { io: "input" }) as Record<string, unknown>;
  return { name, description: t.description, inputSchema, ...(t.annotations ? { annotations: t.annotations } : {}) };
});

type RpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, any> };
const rpcError = (id: RpcRequest["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function callTool(c: Context<AppEnv>, name: string, args: unknown) {
  const tool = TOOLS[name];
  if (!tool) return null;
  const parsed = tool.input.safeParse(args ?? {});
  const fail = (text: string) => ({ content: [{ type: "text", text }], isError: true });
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return fail(`Invalid arguments: ${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`);
  }
  try {
    const result = await tool.run(c, parsed.data);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    if (err instanceof HTTPException) return fail(err.message);
    console.error("mcp tool failed", name, err);
    return fail("Something went wrong running this tool. Try again.");
  }
}

async function handle(c: Context<AppEnv>, msg: RpcRequest): Promise<object | null> {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(msg?.id, -32600, "Invalid request");
  const isNotification = msg.id === undefined || msg.id === null;
  if (isNotification) return null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "inboxos", title: "InboxOS", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: toolList });
    case "tools/call": {
      const res = await callTool(c, String(msg.params?.name ?? ""), msg.params?.arguments);
      return res ? ok(res) : rpcError(msg.id, -32602, `Unknown tool: ${msg.params?.name}`);
    }
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

async function endpoint(c: Context<AppEnv>) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(rpcError(null, -32700, "Parse error"), 400);
  }
  const batch = Array.isArray(body);
  const msgs = (batch ? body : [body]) as RpcRequest[];
  const replies = (await Promise.all(msgs.slice(0, 20).map((m) => handle(c, m)))).filter((r) => r !== null);
  if (!replies.length) return c.body(null, 202);
  return c.json(batch ? replies : replies[0]);
}

// Stateless server: no SSE stream to open and no session to end.
const notAllowed = (c: Context<AppEnv>) => c.json(rpcError(null, -32000, "Method not allowed: use POST"), 405, { Allow: "POST" });

for (const path of ["/", "/:key"]) {
  mcpRoutes.post(path, requireApiKey, endpoint);
  mcpRoutes.get(path, notAllowed);
  mcpRoutes.delete(path, notAllowed);
}
