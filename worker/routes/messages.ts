import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Address, EmailEvent, MessageDetail, View } from "@shared/types";
import { FOLDERS } from "@shared/types";
import type { AppEnv } from "../env";
import { requireMailbox, requireMessage, userMailboxIds } from "../lib/access";
import { collabFilter, isCollabView } from "../lib/collab";
import { toAttachmentInfo, toListItem, type AttachmentRow, type MessageRow } from "../lib/messages";
import { resend } from "../lib/resend";
import { ftsExpression, likeEscape, parseQuery } from "../lib/search";
import { clampInt, parseJson } from "../lib/util";

export const messageRoutes = new Hono<AppEnv>();

const HIDDEN_FROM_ALL = "('trash','spam','drafts','scheduled','snoozed')";

function encodeCursor(r: { date: string; id: string }) {
  return btoa(`${r.date}|${r.id}`);
}
function decodeCursor(s: string | undefined): { date: string; id: string } | null {
  if (!s) return null;
  try {
    const [date, id] = atob(s).split("|");
    return date && id ? { date, id } : null;
  } catch {
    return null;
  }
}

messageRoutes.get("/", async (c) => {
  const u = c.get("user");
  const mailboxId = c.req.query("mailbox") ?? "";
  // "all" = unified view across every mailbox the user can access.
  let mailboxIds: string[];
  if (mailboxId === "all") {
    mailboxIds = await userMailboxIds(c.env.DB, u.id);
    if (!mailboxIds.length) return c.json({ items: [], nextCursor: null });
  } else {
    await requireMailbox(c.env.DB, u, mailboxId);
    mailboxIds = [mailboxId];
  }
  const inMailboxes = `(${mailboxIds.map(() => "?").join(",")})`;
  const view = (c.req.query("view") ?? "inbox") as View;
  const labelId = c.req.query("label") || null;
  const q = (c.req.query("q") ?? "").trim().slice(0, 500);
  const limit = clampInt(c.req.query("limit"), 1, 100, 50);
  const cursor = decodeCursor(c.req.query("cursor"));
  const convStatus = c.req.query("status") || null;

  const where: string[] = [`mailbox_id IN ${inMailboxes}`];
  const args: unknown[] = [...mailboxIds];

  if (q) {
    const p = parseQuery(q);
    if (p.folder) {
      where.push("folder = ?");
      args.push(p.folder);
    } else where.push(`folder NOT IN ('trash','spam')`);
    const fts = ftsExpression(p.text);
    if (fts) {
      where.push("id IN (SELECT message_id FROM messages_fts WHERE messages_fts MATCH ?)");
      args.push(fts);
    }
    for (const f of p.from) {
      where.push(`(from_addr LIKE ? ESCAPE '\\' OR from_name LIKE ? ESCAPE '\\')`);
      args.push(`%${likeEscape(f)}%`, `%${likeEscape(f)}%`);
    }
    for (const t of p.to) {
      where.push(`(to_json LIKE ? ESCAPE '\\' OR cc_json LIKE ? ESCAPE '\\')`);
      args.push(`%${likeEscape(t)}%`, `%${likeEscape(t)}%`);
    }
    for (const s of p.subject) {
      where.push(`subject LIKE ? ESCAPE '\\'`);
      args.push(`%${likeEscape(s)}%`);
    }
    if (p.hasAttachment) where.push("has_attachments = 1");
    if (p.unread) where.push("is_read = 0");
    if (p.read) where.push("is_read = 1");
    if (p.starred) where.push("is_starred = 1");
    if (p.before) {
      where.push("date < ?");
      args.push(p.before);
    }
    if (p.after) {
      where.push("date >= ?");
      args.push(p.after);
    }
    if (p.label) {
      where.push(`id IN (SELECT ml.message_id FROM message_labels ml JOIN labels l ON l.id = ml.label_id WHERE l.mailbox_id IN ${inMailboxes} AND l.name = ? COLLATE NOCASE)`);
      args.push(...mailboxIds, p.label);
    }
  } else if (labelId) {
    where.push(`folder NOT IN ('trash','spam') AND id IN (SELECT message_id FROM message_labels WHERE label_id = ?)`);
    args.push(labelId);
  } else if (view === "starred") {
    where.push(`is_starred = 1 AND folder NOT IN ('trash','spam')`);
  } else if (view === "unread") {
    where.push(`is_read = 0 AND folder NOT IN ${HIDDEN_FROM_ALL}`);
  } else if (view === "all") {
    where.push(`folder NOT IN ${HIDDEN_FROM_ALL}`);
  } else if (isCollabView(view)) {
    const f = collabFilter({ view, status: null, userId: u.id, mailboxIds, hiddenFolders: HIDDEN_FROM_ALL });
    where.push(...f.where);
    args.push(...f.args);
  } else if ((FOLDERS as readonly string[]).includes(view)) {
    where.push("folder = ?");
    args.push(view);
  } else {
    throw new HTTPException(400, { message: "Unknown view" });
  }

  // Status chips (Open / Pending / Closed) narrow any list to conversations in that state.
  if (convStatus) {
    const f = collabFilter({ view: null, status: convStatus, userId: u.id, mailboxIds, hiddenFolders: HIDDEN_FROM_ALL });
    where.push(...f.where);
    args.push(...f.args);
  }

  // Scheduled and snoozed lists read as a timeline: soonest first.
  const orderCol = !q && view === "scheduled" ? "scheduled_at" : !q && view === "snoozed" ? "snoozed_until" : "date";
  const threaded = c.req.query("threads") === "1" && !q && !["drafts", "scheduled", "snoozed"].includes(view);
  const cursorSql = cursor ? `AND (f.${orderCol} < ? OR (f.${orderCol} = ? AND f.id < ?))` : "";
  const cursorArgs = cursor ? [cursor.date, cursor.date, cursor.id] : [];
  const dir = orderCol === "date" ? "DESC" : "ASC";
  const cursorSqlDir = dir === "ASC" ? cursorSql.replace(/</g, ">") : cursorSql;

  const labelSub = "(SELECT group_concat(label_id) FROM message_labels ml WHERE ml.message_id = f.id) AS label_ids";
  // Conversation status and assignee, as one JSON value so it works without joins (and column clashes) in both list shapes.
  const convSub = `(SELECT json_object('status', cv.status, 'id', au.id, 'name', au.name, 'email', au.email, 'color', au.avatar_color)
      FROM conversations cv LEFT JOIN users au ON au.id = cv.assignee_id
      WHERE cv.mailbox_id = f.mailbox_id AND cv.thread_id = f.thread_id) AS conv_json`;
  let sql: string;
  if (threaded) {
    sql = `WITH f AS (SELECT * FROM messages WHERE ${where.join(" AND ")}),
      latest AS (SELECT thread_id, MAX(date) AS d, SUM(1 - is_read) AS unread FROM f GROUP BY thread_id)
      SELECT f.*, latest.unread AS thread_unread, ${labelSub}, ${convSub},
        MAX(1, (SELECT COUNT(*) FROM messages x WHERE x.mailbox_id = f.mailbox_id AND x.thread_id = f.thread_id
                AND x.folder NOT IN ('trash','spam','drafts','scheduled','snoozed'))) AS thread_count
      FROM f JOIN latest ON latest.thread_id = f.thread_id AND latest.d = f.date
      WHERE 1 = 1 ${cursorSqlDir}
      ORDER BY f.date ${dir}, f.id ${dir} LIMIT ?`;
  } else {
    sql = `SELECT f.*, ${labelSub}, ${convSub} FROM messages f WHERE ${where.join(" AND ")} ${cursorSqlDir}
      ORDER BY f.${orderCol} ${dir}, f.id ${dir} LIMIT ?`;
  }
  const { results } = await c.env.DB.prepare(sql)
    .bind(...args, ...cursorArgs, limit + 1)
    .all<MessageRow>();
  const page = results.slice(0, limit);
  const last = page[page.length - 1];
  return c.json({
    items: page.map(toListItem),
    nextCursor:
      results.length > limit && last ? encodeCursor({ date: (orderCol === "scheduled_at" ? last.scheduled_at : orderCol === "snoozed_until" ? last.snoozed_until : last.date) ?? last.date, id: last.id }) : null,
  });
});

export async function buildDetail(c: { env: AppEnv["Bindings"] }, m: MessageRow): Promise<MessageDetail> {
  const db = c.env.DB;
  const [{ results: atts }, { results: events }, { results: labels }, sender, htmlObj] = await Promise.all([
    db.prepare("SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at").bind(m.id).all<AttachmentRow>(),
    db
      .prepare("SELECT id, type, detail, created_at FROM email_events WHERE message_id = ? ORDER BY created_at")
      .bind(m.id)
      .all<{ id: string; type: string; detail: string | null; created_at: string }>(),
    db.prepare("SELECT label_id FROM message_labels WHERE message_id = ?").bind(m.id).all<{ label_id: string }>(),
    m.created_by ? db.prepare("SELECT id, name FROM users WHERE id = ?").bind(m.created_by).first<{ id: string; name: string }>() : null,
    m.html_key ? c.env.FILES.get(m.html_key) : null,
  ]);
  const list = toListItem({ ...m, label_ids: labels.map((l) => l.label_id).join(",") || null });
  return {
    ...list,
    isRead: !!m.is_read,
    cc: parseJson<Address[]>(m.cc_json, []),
    bcc: parseJson<Address[]>(m.bcc_json, []),
    replyTo: parseJson<Address[]>(m.reply_to_json, []),
    html: htmlObj ? await htmlObj.text() : null,
    text: m.text_body,
    messageIdHeader: m.message_id_header,
    inReplyTo: m.in_reply_to,
    references: m.references_header,
    headers: parseJson<Record<string, string>>(m.headers_json, {}),
    attachments: atts.map(toAttachmentInfo),
    resendId: m.resend_id,
    error: m.error,
    openCount: m.open_count,
    clickCount: m.click_count,
    events: events.map<EmailEvent>((e) => ({ id: e.id, type: e.type, detail: e.detail, createdAt: e.created_at })),
    sentBy: sender ?? null,
  };
}

messageRoutes.get("/:id", async (c) => {
  const m = await requireMessage<MessageRow>(c.env.DB, c.get("user"), c.req.param("id"));
  return c.json(await buildDetail(c, m));
});

/** Every message in the conversation, oldest first. */
messageRoutes.get("/:id/thread", async (c) => {
  const m = await requireMessage<MessageRow>(c.env.DB, c.get("user"), c.req.param("id"));
  const scope =
    m.folder === "trash" ? "folder = 'trash'" : m.folder === "spam" ? "folder = 'spam'" : "folder NOT IN ('trash','spam')";
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM messages WHERE mailbox_id = ? AND thread_id = ? AND ${scope} ORDER BY date ASC LIMIT 100`,
  )
    .bind(m.mailbox_id, m.thread_id)
    .all<MessageRow>();
  const rows = results.length ? results : [m];
  return c.json(await Promise.all(rows.map((r) => buildDetail(c, r))));
});

/** Download the original MIME source of a received message (.eml). */
messageRoutes.get("/:id/original", async (c) => {
  const m = await requireMessage<MessageRow>(c.env.DB, c.get("user"), c.req.param("id"));
  if (m.direction !== "inbound" || !m.resend_id) {
    throw new HTTPException(404, { message: "The original source is only available for received messages." });
  }
  const email = (await resend.getReceived(c.env.RESEND_API_KEY, m.resend_id)) as { raw?: { download_url?: string } };
  const url = email.raw?.download_url;
  if (!url) throw new HTTPException(404, { message: "Original source is no longer available from the provider." });
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new HTTPException(502, { message: "Couldn't fetch the original message." });
  const name = (m.subject || "message").replace(/[^\w\- ]+/g, "").trim().slice(0, 60) || "message";
  return new Response(res.body, {
    headers: {
      "Content-Type": "message/rfc822",
      "Content-Disposition": `attachment; filename="${name}.eml"`,
      "Cache-Control": "private, no-store",
    },
  });
});
