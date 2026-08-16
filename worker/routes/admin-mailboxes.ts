import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { MailboxRole } from "@shared/types";
import type { AppEnv } from "../env";
import { audit } from "../lib/audit";
import { purgeMessages } from "../lib/messages";
import { getPolicy, saveSetting } from "../lib/settings";
import { ensureMailbox } from "../lib/users";
import { now } from "../lib/util";
import { parseBody, zColor, zEmail, zId } from "../lib/validate";

export const adminMailboxRoutes = new Hono<AppEnv>();

adminMailboxRoutes.get("/", async (c) => {
  const db = c.env.DB;
  const [{ results: boxes }, { results: members }, { results: aliases }, { results: stats }] = await Promise.all([
    db.prepare("SELECT * FROM mailboxes ORDER BY is_active DESC, type, address").all<{
      id: string;
      address: string;
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
  const policy = await getPolicy(db);
  return c.json(
    boxes.map((b) => {
      const s = stats.find((x) => x.mailbox_id === b.id);
      return {
        id: b.id,
        address: b.address,
        displayName: b.display_name,
        type: b.type,
        color: b.color,
        signatureHtml: b.signature_html,
        isActive: !!b.is_active,
        isCatchAll: policy.catchAllMailboxId === b.id,
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

async function addressTaken(db: D1Database, address: string): Promise<boolean> {
  const r = await db
    .prepare("SELECT 1 FROM mailboxes WHERE address = ?1 UNION SELECT 1 FROM mailbox_aliases WHERE address = ?1")
    .bind(address)
    .first();
  return !!r;
}

adminMailboxRoutes.post("/", async (c) => {
  const body = await parseBody(
    c,
    z.object({
      address: zEmail,
      displayName: z.string().trim().max(120).default(""),
      type: z.enum(["personal", "shared"]).default("shared"),
      members: z.array(z.object({ userId: zId, role: z.enum(["owner", "editor", "viewer"]) })).max(200).default([]),
    }),
  );
  if (await addressTaken(c.env.DB, body.address)) throw new HTTPException(409, { message: "That address is already in use." });
  const id = await ensureMailbox(c.env.DB, { address: body.address, displayName: body.displayName, type: body.type });
  if (body.members.length) {
    const t = now();
    await c.env.DB.batch(
      body.members.map((m) =>
        c.env.DB.prepare("INSERT OR REPLACE INTO mailbox_members (mailbox_id, user_id, role, created_at) VALUES (?, ?, ?, ?)").bind(id, m.userId, m.role, t),
      ),
    );
  }
  await audit(c, { action: "mailbox.created", targetType: "mailbox", targetId: id, meta: { address: body.address, type: body.type } });
  return c.json({ id }, 201);
});

adminMailboxRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await parseBody(
    c,
    z.object({
      displayName: z.string().trim().max(120).optional(),
      type: z.enum(["personal", "shared"]).optional(),
      color: zColor.optional(),
      signatureHtml: z.string().max(20_000).optional(),
      isActive: z.boolean().optional(),
      isCatchAll: z.boolean().optional(),
    }),
  );
  const res = await c.env.DB.prepare(
    `UPDATE mailboxes SET display_name = COALESCE(?, display_name), type = COALESCE(?, type), color = COALESCE(?, color),
       signature_html = COALESCE(?, signature_html), is_active = COALESCE(?, is_active), updated_at = ? WHERE id = ?`,
  )
    .bind(
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
  const mb = await c.env.DB.prepare("SELECT address FROM mailboxes WHERE id = ?").bind(id).first<{ address: string }>();
  if (!mb) throw new HTTPException(404, { message: "Mailbox not found" });
  if (confirm.toLowerCase() !== mb.address.toLowerCase()) throw new HTTPException(400, { message: "Type the mailbox address to confirm." });
  // Purge in chunks so large mailboxes don't exceed per-request limits; the client retries until done.
  const { results } = await c.env.DB.prepare("SELECT id FROM messages WHERE mailbox_id = ? LIMIT 500").bind(id).all<{ id: string }>();
  await purgeMessages(c.env.DB, c.env.FILES, results.map((r) => r.id));
  if (results.length === 500) return c.json({ ok: false, remaining: true });
  const orphans = await c.env.FILES.list({ prefix: `mail/${id}/` });
  if (orphans.objects.length) await c.env.FILES.delete(orphans.objects.map((o) => o.key));
  await c.env.DB.prepare("DELETE FROM mailboxes WHERE id = ?").bind(id).run();
  const policy = await getPolicy(c.env.DB);
  if (policy.catchAllMailboxId === id) await saveSetting(c.env.DB, "policy", { ...policy, catchAllMailboxId: null }, c.get("user").id);
  await audit(c, { action: "mailbox.deleted", targetType: "mailbox", targetId: id, meta: { address: mb.address } });
  return c.json({ ok: true, remaining: false });
});

// ---- Members --------------------------------------------------------------

adminMailboxRoutes.put("/:id/members/:userId", async (c) => {
  const { id, userId } = c.req.param();
  const { role } = await parseBody(c, z.object({ role: z.enum(["owner", "editor", "viewer"]) }));
  const ok = await c.env.DB.prepare("SELECT (SELECT 1 FROM mailboxes WHERE id = ?) AS m, (SELECT 1 FROM users WHERE id = ?) AS u")
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
  await c.env.DB.prepare("DELETE FROM mailbox_members WHERE mailbox_id = ? AND user_id = ?").bind(id, userId).run();
  await audit(c, { action: "mailbox.member_removed", targetType: "mailbox", targetId: id, meta: { userId } });
  return c.json({ ok: true });
});

// ---- Aliases --------------------------------------------------------------

adminMailboxRoutes.post("/:id/aliases", async (c) => {
  const id = c.req.param("id");
  const { address } = await parseBody(c, z.object({ address: zEmail }));
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
