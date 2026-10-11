import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AdminMailboxRow, PageOf } from "@shared/admin";
import { recordsToCsv } from "@shared/csv";
import type { MailboxRole } from "@shared/types";
import type { AppEnv } from "../env";
import { audit } from "../lib/audit";
import { csvDownload, EXPORT_MAX_ROWS } from "../lib/csv-download";
import { heldMailboxIds, isHeld, snapshotMembershipStatement } from "../lib/legal-hold";
import { addressTaken, deleteMailboxStep, LEGAL_HOLD_MAILBOX, MAILBOX_LIST_SELECT, mailboxListSql, parseMailboxFilter, parseMailboxSort } from "../lib/mailbox-admin";
import { getPolicy, saveSetting } from "../lib/settings";
import { ensureMailbox } from "../lib/users";
import { clampInt, now } from "../lib/util";
import { parseBody, zColor, zEmail, zId } from "../lib/validate";
import { emitFromRequest } from "../lib/webhooks";

export const adminMailboxRoutes = new Hono<AppEnv>();

/** Every mailbox with all members, for pickers (access dialogs, holds, traffic filters). The Mailboxes page uses /search. */
adminMailboxRoutes.get("/", async (c) => {
  const db = c.env.DB;
  const [{ results: boxes }, { results: members }, { results: aliases }, { results: stats }] = await Promise.all([
    db.prepare("SELECT * FROM mailboxes WHERE is_system = 0 ORDER BY is_active DESC, type, address").all<{
      id: string;
      address: string;
      name: string;
      display_name: string;
      type: string;
      color: string;
      signature_html: string;
      is_active: number;
      created_at: string;
    }>(),
    db
      .prepare(
        `SELECT mm.mailbox_id, mm.role, u.id, u.name, u.email, u.avatar_color FROM mailbox_members mm
         JOIN users u ON u.id = mm.user_id ORDER BY u.name COLLATE NOCASE`,
      )
      .all<{ mailbox_id: string; role: MailboxRole; id: string; name: string; email: string; avatar_color: string }>(),
    db.prepare("SELECT address, mailbox_id FROM mailbox_aliases ORDER BY address").all<{ address: string; mailbox_id: string }>(),
    db
      .prepare("SELECT mailbox_id, COUNT(*) AS messages, COALESCE(SUM(size), 0) AS bytes, MAX(date) AS last FROM messages GROUP BY mailbox_id")
      .all<{ mailbox_id: string; messages: number; bytes: number; last: string | null }>(),
  ]);
  const [policy, held] = await Promise.all([getPolicy(db), heldMailboxIds(db)]);
  return c.json(
    boxes.map((b) => {
      const s = stats.find((x) => x.mailbox_id === b.id);
      return {
        id: b.id,
        address: b.address,
        name: b.name,
        displayName: b.display_name,
        type: b.type,
        color: b.color,
        signatureHtml: b.signature_html,
        isActive: !!b.is_active,
        isCatchAll: policy.catchAllMailboxId === b.id,
        legalHold: held.has(b.id),
        createdAt: b.created_at,
        messageCount: s?.messages ?? 0,
        storageBytes: s?.bytes ?? 0,
        lastActivity: s?.last ?? null,
        aliases: aliases.filter((a) => a.mailbox_id === b.id).map((a) => a.address),
        members: members
          .filter((m) => m.mailbox_id === b.id)
          .map((m) => ({ userId: m.id, name: m.name, email: m.email, avatarColor: m.avatar_color, role: m.role })),
      };
    }),
  );
});

interface MailboxListRow {
  id: string;
  address: string;
  name: string;
  display_name: string;
  type: "personal" | "shared";
  color: string;
  is_active: number;
  created_at: string;
  member_count: number;
  alias_count: number;
}

/** One page of the Mailboxes table: search, filters, sort. Message stats are only computed for the page shown. */
adminMailboxRoutes.get("/search", async (c) => {
  const params = c.req.query();
  const { sort, dir } = parseMailboxSort(params);
  const { where, binds, order } = mailboxListSql(parseMailboxFilter(params), sort, dir);
  const limit = clampInt(params.limit, 10, 200, 50);
  const page = clampInt(params.page, 1, 100_000, 1);
  const db = c.env.DB;
  const [{ results: boxes }, total, types] = await Promise.all([
    db.prepare(`${MAILBOX_LIST_SELECT} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...binds, limit, (page - 1) * limit).all<MailboxListRow>(),
    db.prepare(`SELECT COUNT(*) AS n FROM mailboxes m ${where}`).bind(...binds).first<{ n: number }>(),
    db.prepare("SELECT type, COUNT(*) AS n FROM mailboxes WHERE is_system = 0 GROUP BY type").all<{ type: string; n: number }>(),
  ]);
  const ids = JSON.stringify(boxes.map((b) => b.id));
  const [{ results: members }, { results: stats }, policy, held] = await Promise.all([
    db
      .prepare(
        `SELECT * FROM (SELECT mm.mailbox_id, mm.role, u.id, u.name, u.email, u.avatar_color,
           ROW_NUMBER() OVER (PARTITION BY mm.mailbox_id ORDER BY mm.role = 'owner' DESC, u.name COLLATE NOCASE) AS n
         FROM mailbox_members mm JOIN users u ON u.id = mm.user_id WHERE mm.mailbox_id IN (SELECT value FROM json_each(?))) WHERE n <= 5`,
      )
      .bind(ids)
      .all<{ mailbox_id: string; role: MailboxRole; id: string; name: string; email: string; avatar_color: string }>(),
    db
      .prepare(
        `SELECT mailbox_id, COUNT(*) AS messages, COALESCE(SUM(size), 0) AS bytes, MAX(date) AS last FROM messages
         WHERE mailbox_id IN (SELECT value FROM json_each(?)) GROUP BY mailbox_id`,
      )
      .bind(ids)
      .all<{ mailbox_id: string; messages: number; bytes: number; last: string | null }>(),
    getPolicy(db),
    heldMailboxIds(db),
  ]);
  const items: AdminMailboxRow[] = boxes.map((b) => {
    const s = stats.find((x) => x.mailbox_id === b.id);
    return {
      id: b.id,
      address: b.address,
      name: b.name,
      displayName: b.display_name,
      type: b.type,
      color: b.color,
      isActive: !!b.is_active,
      isCatchAll: policy.catchAllMailboxId === b.id,
      legalHold: held.has(b.id),
      createdAt: b.created_at,
      memberCount: b.member_count,
      aliasCount: b.alias_count,
      members: members.filter((m) => m.mailbox_id === b.id).map((m) => ({ userId: m.id, name: m.name, email: m.email, avatarColor: m.avatar_color, role: m.role })),
      messageCount: s?.messages ?? 0,
      storageBytes: s?.bytes ?? 0,
      lastActivity: s?.last ?? null,
    };
  });
  const body: PageOf<AdminMailboxRow> & { counts: Record<string, number> } = {
    items,
    total: total?.n ?? 0,
    page,
    limit,
    counts: Object.fromEntries(types.results.map((t) => [t.type, t.n])),
  };
  return c.json(body);
});

/** CSV of the mailboxes matching the current filters, with members, in the shape the import understands. */
adminMailboxRoutes.get("/export", async (c) => {
  const params = c.req.query();
  const { sort, dir } = parseMailboxSort(params);
  const { where, binds, order } = mailboxListSql(parseMailboxFilter(params), sort, dir);
  const { results } = await c.env.DB.prepare(
    `SELECT m.address, m.name, m.display_name, m.type, m.is_active, m.created_at,
       (SELECT COUNT(*) FROM mailbox_members mm WHERE mm.mailbox_id = m.id) AS member_count,
       (SELECT group_concat(u.email || ':' || mm.role, ';') FROM mailbox_members mm JOIN users u ON u.id = mm.user_id WHERE mm.mailbox_id = m.id) AS members,
       (SELECT group_concat(a.address, ';') FROM mailbox_aliases a WHERE a.mailbox_id = m.id) AS aliases
     FROM mailboxes m ${where} ORDER BY ${order} LIMIT ?`,
  )
    .bind(...binds, EXPORT_MAX_ROWS)
    .all<{ address: string; name: string; display_name: string; type: string; is_active: number; created_at: string; members: string | null; aliases: string | null }>();
  type R = (typeof results)[number];
  const csv = recordsToCsv<R>(
    [
      { header: "address", value: (r) => r.address },
      { header: "name", value: (r) => r.name },
      { header: "display_name", value: (r) => r.display_name },
      { header: "type", value: (r) => r.type },
      { header: "members", value: (r) => r.members ?? "" },
      { header: "aliases", value: (r) => r.aliases ?? "" },
      { header: "active", value: (r) => (r.is_active ? "yes" : "no") },
      { header: "created", value: (r) => r.created_at },
    ],
    results,
  );
  await audit(c, { action: "mailbox.exported", targetType: "mailbox", meta: { count: results.length, filter: parseMailboxFilter(params) } });
  return csvDownload("mailboxes", csv);
});

/** CSV of aliases (address → mailbox) for the mailboxes matching the current filters. */
adminMailboxRoutes.get("/aliases/export", async (c) => {
  const { where, binds } = mailboxListSql(parseMailboxFilter(c.req.query()));
  const { results } = await c.env.DB.prepare(
    `SELECT a.address, m.address AS mailbox, a.created_at FROM mailbox_aliases a JOIN mailboxes m ON m.id = a.mailbox_id ${where}
     ORDER BY m.address, a.address LIMIT ?`,
  )
    .bind(...binds, EXPORT_MAX_ROWS)
    .all<{ address: string; mailbox: string; created_at: string }>();
  const csv = recordsToCsv<(typeof results)[number]>(
    [
      { header: "address", value: (r) => r.address },
      { header: "mailbox", value: (r) => r.mailbox },
      { header: "created", value: (r) => r.created_at },
    ],
    results,
  );
  await audit(c, { action: "mailbox.aliases_exported", targetType: "mailbox", meta: { count: results.length } });
  return csvDownload("aliases", csv);
});

adminMailboxRoutes.post("/", async (c) => {
  const body = await parseBody(
    c,
    z.object({
      address: zEmail,
      name: z.string().trim().max(80).default(""),
      displayName: z.string().trim().max(120).default(""),
      type: z.enum(["personal", "shared"]).default("shared"),
      members: z.array(z.object({ userId: zId, role: z.enum(["owner", "editor", "viewer"]) })).max(200).default([]),
    }),
  );
  if (await addressTaken(c.env.DB, body.address)) throw new HTTPException(409, { message: "That address is already in use." });
  const id = await ensureMailbox(c.env.DB, { address: body.address, name: body.name, displayName: body.displayName, type: body.type });
  if (body.members.length) {
    const t = now();
    await c.env.DB.batch(
      body.members.map((m) =>
        c.env.DB.prepare("INSERT OR REPLACE INTO mailbox_members (mailbox_id, user_id, role, created_at) VALUES (?, ?, ?, ?)").bind(id, m.userId, m.role, t),
      ),
    );
  }
  await audit(c, { action: "mailbox.created", targetType: "mailbox", targetId: id, meta: { address: body.address, type: body.type } });
  emitFromRequest(c, [{ type: "mailbox.created", data: { id, address: body.address, type: body.type, via: "admin" } }]);
  return c.json({ id }, 201);
});

adminMailboxRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await parseBody(
    c,
    z.object({
      name: z.string().trim().max(80).optional(),
      displayName: z.string().trim().max(120).optional(),
      type: z.enum(["personal", "shared"]).optional(),
      color: zColor.optional(),
      signatureHtml: z.string().max(20_000).optional(),
      isActive: z.boolean().optional(),
      isCatchAll: z.boolean().optional(),
    }),
  );
  const res = await c.env.DB.prepare(
    `UPDATE mailboxes SET name = COALESCE(?, name), display_name = COALESCE(?, display_name), type = COALESCE(?, type), color = COALESCE(?, color),
       signature_html = COALESCE(?, signature_html), is_active = COALESCE(?, is_active), updated_at = ? WHERE id = ? AND is_system = 0`,
  )
    .bind(
      body.name ?? null,
      body.displayName ?? null,
      body.type ?? null,
      body.color ?? null,
      body.signatureHtml ?? null,
      body.isActive === undefined ? null : body.isActive ? 1 : 0,
      now(),
      id,
    )
    .run();
  if (!res.meta.changes) throw new HTTPException(404, { message: "Mailbox not found" });
  if (body.isCatchAll !== undefined) {
    const policy = await getPolicy(c.env.DB);
    const next = body.isCatchAll ? id : policy.catchAllMailboxId === id ? null : policy.catchAllMailboxId;
    await saveSetting(c.env.DB, "policy", { ...policy, catchAllMailboxId: next }, c.get("user").id);
  }
  await audit(c, { action: "mailbox.updated", targetType: "mailbox", targetId: id, meta: body });
  return c.json({ ok: true });
});

adminMailboxRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const { confirm } = await parseBody(c, z.object({ confirm: z.string() }));
  const mb = await c.env.DB.prepare("SELECT address FROM mailboxes WHERE id = ? AND is_system = 0").bind(id).first<{ address: string }>();
  if (!mb) throw new HTTPException(404, { message: "Mailbox not found" });
  if (confirm.toLowerCase() !== mb.address.toLowerCase()) throw new HTTPException(400, { message: "Type the mailbox address to confirm." });
  // Deleting the mailbox row would cascade to its messages, so a held mailbox can't be deleted at all.
  if (await isHeld(c.env.DB, id)) throw new HTTPException(409, { message: LEGAL_HOLD_MAILBOX });
  // Purge in chunks so large mailboxes don't exceed per-request limits; the client retries until done.
  const step = await deleteMailboxStep(c.env, id, c.get("user").id);
  if (!step.done) return c.json({ ok: false, remaining: true });
  await audit(c, { action: "mailbox.deleted", targetType: "mailbox", targetId: id, meta: { address: mb.address } });
  emitFromRequest(c, [{ type: "mailbox.deleted", data: { id, address: mb.address, via: "admin" } }]);
  return c.json({ ok: true, remaining: false });
});

// ---- Members --------------------------------------------------------------

adminMailboxRoutes.put("/:id/members/:userId", async (c) => {
  const { id, userId } = c.req.param();
  const { role } = await parseBody(c, z.object({ role: z.enum(["owner", "editor", "viewer"]) }));
  const ok = await c.env.DB.prepare("SELECT (SELECT 1 FROM mailboxes WHERE id = ? AND is_system = 0) AS m, (SELECT 1 FROM users WHERE id = ?) AS u")
    .bind(id, userId)
    .first<{ m: number | null; u: number | null }>();
  if (!ok?.m || !ok.u) throw new HTTPException(404, { message: "Mailbox or user not found" });
  await c.env.DB.prepare(
    `INSERT INTO mailbox_members (mailbox_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(mailbox_id, user_id) DO UPDATE SET role = excluded.role`,
  )
    .bind(id, userId, role, now())
    .run();
  await audit(c, { action: "mailbox.member_set", targetType: "mailbox", targetId: id, meta: { userId, role, self: userId === c.get("user").id } });
  return c.json({ ok: true });
});

adminMailboxRoutes.delete("/:id/members/:userId", async (c) => {
  const { id, userId } = c.req.param();
  await c.env.DB.batch([
    snapshotMembershipStatement(c.env.DB, userId, id),
    c.env.DB.prepare("DELETE FROM mailbox_members WHERE mailbox_id = ? AND user_id = ?").bind(id, userId),
  ]);
  await audit(c, { action: "mailbox.member_removed", targetType: "mailbox", targetId: id, meta: { userId } });
  return c.json({ ok: true });
});

// ---- Aliases --------------------------------------------------------------

adminMailboxRoutes.post("/:id/aliases", async (c) => {
  const id = c.req.param("id");
  const { address } = await parseBody(c, z.object({ address: zEmail }));
  const target = await c.env.DB.prepare("SELECT 1 FROM mailboxes WHERE id = ? AND is_system = 0").bind(id).first();
  if (!target) throw new HTTPException(404, { message: "Mailbox not found" });
  if (await addressTaken(c.env.DB, address)) throw new HTTPException(409, { message: "That address is already in use." });
  await c.env.DB.prepare("INSERT INTO mailbox_aliases (address, mailbox_id, created_at) VALUES (?, ?, ?)").bind(address, id, now()).run();
  await audit(c, { action: "mailbox.alias_added", targetType: "mailbox", targetId: id, meta: { address } });
  return c.json({ ok: true }, 201);
});

adminMailboxRoutes.delete("/:id/aliases/:address", async (c) => {
  const { id, address } = c.req.param();
  await c.env.DB.prepare("DELETE FROM mailbox_aliases WHERE mailbox_id = ? AND address = ?").bind(id, decodeURIComponent(address)).run();
  await audit(c, { action: "mailbox.alias_removed", targetType: "mailbox", targetId: id, meta: { address } });
  return c.json({ ok: true });
});
