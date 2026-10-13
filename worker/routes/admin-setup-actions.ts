import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { mailDomains } from "@shared/brand";
import type { AppEnv } from "../env";
import { audit } from "../lib/audit";
import { renderEmail } from "../lib/email-layout";
import { getResendApiKey } from "../lib/provider-config";
import { explainKeyError, resend, ResendError } from "../lib/resend";
import { loadSettings } from "../lib/settings";
import { loadSetupState, updateSetupState } from "../lib/setup";
import { logSystemEmail } from "../lib/system-mail";
import { ensureMailbox, getUserByEmail, insertUser } from "../lib/users";
import { domainOf, formatAddress, newId, now } from "../lib/util";
import { parseBody, zEmail } from "../lib/validate";
import { emailInvite, issueToken } from "./admin-users";
import { assertFeature } from "../lib/features";

/** Wizard steps that create things: mailboxes and invitations. Mounted under /api/admin/setup. */
export const setupTeamRoutes = new Hono<AppEnv>();

async function addressOwner(db: D1Database, address: string): Promise<{ mailboxId: string; alias: boolean } | null> {
  const box = await db.prepare("SELECT id FROM mailboxes WHERE address = ?").bind(address).first<{ id: string }>();
  if (box) return { mailboxId: box.id, alias: false };
  const alias = await db.prepare("SELECT mailbox_id FROM mailbox_aliases WHERE address = ?").bind(address).first<{ mailbox_id: string }>();
  return alias ? { mailboxId: alias.mailbox_id, alias: true } : null;
}

setupTeamRoutes.post("/mailboxes", async (c) => {
  const body = await parseBody(
    c,
    z.object({
      personal: z.object({ address: zEmail, displayName: z.string().trim().max(120).default("") }).optional(),
      shared: z.array(z.object({ address: zEmail, name: z.string().trim().max(80).default("") })).max(20).default([]),
    }),
  );
  if (body.shared.length) await assertFeature(c, "sharedInboxes");
  const me = c.get("user");
  const { brand } = await loadSettings(c.env.DB);
  const domains = mailDomains(brand);
  if (!domains.length) throw new HTTPException(400, { message: "Add a domain first, so mailboxes have somewhere to live." });
  const created: { id: string; address: string; type: "personal" | "shared" }[] = [];
  const skipped: { address: string; reason: string }[] = [];
  const wanted = [
    ...(body.personal ? [{ address: body.personal.address, name: body.personal.displayName || me.name, type: "personal" as const }] : []),
    ...body.shared.map((s) => ({ address: s.address, name: s.name, type: "shared" as const })),
  ];
  for (const w of wanted) {
    if (!domains.includes(domainOf(w.address))) {
      skipped.push({ address: w.address, reason: `Not on one of your domains (${domains.join(", ")}).` });
      continue;
    }
    const taken = await addressOwner(c.env.DB, w.address);
    if (taken) {
      skipped.push({ address: w.address, reason: taken.alias ? "Already an alias of another mailbox." : "Already exists." });
      continue;
    }
    // The owner joins every inbox made here as its owner, so it shows up in their sidebar.
    const id = await ensureMailbox(c.env.DB, { address: w.address, name: w.type === "shared" ? w.name : "", displayName: w.name || brand.companyName || w.address, type: w.type, ownerId: me.id });
    created.push({ id, address: w.address, type: w.type });
    await audit(c, { action: "mailbox.created", targetType: "mailbox", targetId: id, meta: { address: w.address, type: w.type, via: "setup" } });
  }
  return c.json({ created, skipped });
});

setupTeamRoutes.post("/invites", async (c) => {
  const body = await parseBody(
    c,
    z.object({
      invites: z.array(z.object({ email: zEmail, name: z.string().trim().max(120).default(""), role: z.enum(["admin", "manager", "member"]).default("member") })).min(1).max(50),
      /** Shared inboxes everyone invited here can read and answer. */
      sharedMailboxIds: z.array(z.string().min(1).max(64)).max(50).default([]),
      sendEmail: z.boolean().default(true),
    }),
  );
  const me = c.get("user");
  const { brand } = await loadSettings(c.env.DB);
  const domains = mailDomains(brand);
  const results: { email: string; status: "invited" | "exists"; inviteUrl?: string; emailed?: boolean; mailbox?: string }[] = [];
  for (const inv of body.invites) {
    if (await getUserByEmail(c.env.DB, inv.email)) {
      results.push({ email: inv.email, status: "exists" });
      continue;
    }
    const id = await insertUser(c.env.DB, { email: inv.email, name: inv.name, role: inv.role, status: "invited" });
    // Someone invited at a work address gets that address as their personal mailbox.
    let mailbox: string | undefined;
    if (domains.includes(domainOf(inv.email)) && !(await addressOwner(c.env.DB, inv.email))) {
      await ensureMailbox(c.env.DB, { address: inv.email, displayName: inv.name, type: "personal", ownerId: id });
      mailbox = inv.email;
    }
    if (body.sharedMailboxIds.length) {
      const t = now();
      await c.env.DB.batch(
        body.sharedMailboxIds.map((mb) =>
          c.env.DB.prepare(
            `INSERT OR IGNORE INTO mailbox_members (mailbox_id, user_id, role, created_at)
             SELECT ?1, ?2, 'editor', ?3 WHERE EXISTS (SELECT 1 FROM mailboxes WHERE id = ?1 AND is_system = 0)`,
          ).bind(mb, id, t),
        ),
      );
    }
    const inviteUrl = await issueToken(c.env, id, "invite", me.id, 24 * 7);
    const emailed = body.sendEmail ? await emailInvite(c.env, inv.email, inviteUrl, me.name || me.email, inv.name) : false;
    await audit(c, { action: "user.invited", targetType: "user", targetId: id, meta: { email: inv.email, role: inv.role, mailbox: mailbox ?? null, access: body.sharedMailboxIds, via: "setup" } });
    results.push({ email: inv.email, status: "invited", inviteUrl, emailed, mailbox });
  }
  return c.json({ results });
});

// ---- Tests -------------------------------------------------------------------

/** Send a test message and watch it arrive. Mounted under /api/admin/setup/test. */
export const setupTestRoutes = new Hono<AppEnv>();

async function senderMailbox(db: D1Database, id: string) {
  const box = await db.prepare("SELECT id, address, display_name FROM mailboxes WHERE id = ? AND is_active = 1 AND is_system = 0").bind(id).first<{ id: string; address: string; display_name: string }>();
  if (!box) throw new HTTPException(404, { message: "Mailbox not found." });
  return box;
}

function sendFailure(err: unknown): string {
  if (err instanceof ResendError) return err.code === "validation_error" ? err.message : explainKeyError(err).message;
  return "Couldn't reach the email provider.";
}

setupTestRoutes.post("/send", async (c) => {
  const body = await parseBody(c, z.object({ mailboxId: z.string().min(1).max(64), to: zEmail }));
  const box = await senderMailbox(c.env.DB, body.mailboxId);
  const { brand } = await loadSettings(c.env.DB);
  const subject = `Test email from ${brand.productName}`;
  const { html, text } = renderEmail(brand, c.env.APP_URL, {
    subject,
    preheader: "If you can read this, sending works.",
    eyebrow: "Test",
    heading: "Sending works",
    paragraphs: [`This message was sent from ${box.address} to check that ${brand.productName} can deliver mail.`, "Nothing else to do: you can delete it."],
  });
  const at = now();
  let resendId: string | null = null;
  let error: string | undefined;
  try {
    resendId = (await resend.send(await getResendApiKey(c.env), { from: formatAddress({ email: box.address, name: box.display_name }), to: [body.to], subject, html, text, tags: [{ name: "category", value: "setup_test" }] })).id;
  } catch (err) {
    error = sendFailure(err);
  }
  await logSystemEmail(c.env, { resendId, to: body.to, subject, category: "setup_test", ...(error ? { error } : {}) });
  await updateSetupState(c.env.DB, c.get("user").id, (s) => {
    s.test.send = { to: body.to, from: box.address, resendId, at, ...(error ? { error } : {}) };
  });
  await audit(c, { action: "setup.test_sent", targetType: "mailbox", targetId: box.id, meta: { to: body.to, ok: !error } });
  if (error) throw new HTTPException(400, { message: error });
  return c.json({ ok: true, resendId });
});

/** Send from a mailbox to itself; it must come back in through the webhook. */
setupTestRoutes.post("/loopback", async (c) => {
  const body = await parseBody(c, z.object({ mailboxId: z.string().min(1).max(64) }));
  const box = await senderMailbox(c.env.DB, body.mailboxId);
  const { brand } = await loadSettings(c.env.DB);
  const token = newId(6).replace(/[^A-Za-z0-9]/g, "x");
  const subject = `Setup check ${token}`;
  const at = now();
  let resendId: string | null = null;
  let error: string | undefined;
  try {
    resendId = (
      await resend.send(await getResendApiKey(c.env), {
        from: formatAddress({ email: box.address, name: box.display_name }),
        to: [box.address],
        subject,
        text: `${brand.productName} sent this to itself to check that receiving works. You can delete it.`,
        tags: [{ name: "category", value: "setup_test" }],
      })
    ).id;
  } catch (err) {
    error = sendFailure(err);
  }
  await logSystemEmail(c.env, { resendId, to: box.address, subject, category: "setup_test", ...(error ? { error } : {}) });
  await updateSetupState(c.env.DB, c.get("user").id, (s) => {
    s.test.loopback = { token, mailboxId: box.id, address: box.address, resendId, at, ...(error ? { error } : {}) };
  });
  if (error) throw new HTTPException(400, { message: error });
  return c.json({ ok: true, token });
});

/** Live status of the tests: provider events, and whether the loopback message arrived. */
setupTestRoutes.get("/", async (c) => {
  const state = await loadSetupState(c.env.DB);
  const events = async (resendId: string | null | undefined) =>
    resendId
      ? (await c.env.DB.prepare("SELECT type, detail, created_at FROM email_events WHERE resend_id = ? AND type != 'system' ORDER BY created_at").bind(resendId).all<{ type: string; detail: string | null; created_at: string }>()).results
      : [];
  const lb = state.test.loopback;
  let arrived: { mailboxId: string; unrouted: boolean; at: string; messageId: string } | null = null;
  if (lb && !lb.error) {
    const row = await c.env.DB.prepare(
      "SELECT id, mailbox_id, created_at FROM messages WHERE direction = 'inbound' AND subject LIKE ? AND created_at >= ? ORDER BY created_at LIMIT 1",
    )
      .bind(`%${lb.token}%`, lb.at)
      .first<{ id: string; mailbox_id: string; created_at: string }>();
    if (row) {
      arrived = { mailboxId: row.mailbox_id, unrouted: row.mailbox_id === "system-unrouted", at: row.created_at, messageId: row.id };
      if (!lb.receivedAt) {
        await updateSetupState(c.env.DB, null, (s) => {
          if (s.test.loopback?.token === lb.token) s.test.loopback.receivedAt = row.created_at;
        });
        await audit(c, { action: "setup.test_received", targetType: "mailbox", targetId: lb.mailboxId });
      }
    }
  }
  return c.json({
    send: state.test.send ? { ...state.test.send, events: await events(state.test.send.resendId) } : null,
    loopback: lb ? { ...lb, events: await events(lb.resendId), arrived } : null,
  });
});
