import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  checkAliasRow,
  checkMailboxRow,
  checkUserRow,
  countImport,
  IMPORT_CHUNK,
  IMPORT_MAX_ROWS,
  ROW_KEY,
  type ImportKind,
  type ImportResponse,
  type ImportRowResult,
  type RowCheck,
} from "@shared/admin-import";
import type { AppEnv } from "../env";
import { auditMany, type AuditEntry } from "../lib/audit";
import { addressTaken } from "../lib/mailbox-admin";
import { zProfilePatch } from "../lib/profile";
import { ensureMailbox, insertUser } from "../lib/users";
import { now } from "../lib/util";
import { parseBody } from "../lib/validate";
import { emitFromRequest, type QueuedEvent } from "../lib/webhooks";
import { emailInvite, issueToken } from "./admin-users";

/**
 * CSV imports (Admin → Users / Mailboxes → Import). The browser parses the file and
 * maps columns; every row is checked again here. A dry run reports what would happen
 * to each row; a commit (at most IMPORT_CHUNK rows per request) does it. Rows that
 * already exist are skipped with a note, so re-running an import is safe.
 */
export const adminImportRoutes = new Hono<AppEnv>();

const zImport = z.object({
  rows: z.array(z.record(z.string(), z.string().max(5000))).min(1, "The file has no rows.").max(IMPORT_MAX_ROWS, `Import at most ${IMPORT_MAX_ROWS.toLocaleString()} rows at a time.`),
  dryRun: z.boolean().default(true),
  /** Row number of the first row in this request, for chunked commits. */
  startRow: z.number().int().min(1).max(IMPORT_MAX_ROWS).default(1),
});

type Body = z.infer<typeof zImport>;

interface Checked<T> {
  result: ImportRowResult;
  value: T | null;
}

/** Shared first pass: row checks, then duplicates within the file. */
function firstPass<T>(kind: ImportKind, body: Body, check: (r: Record<string, unknown>) => RowCheck<T>): Checked<T>[] {
  const seen = new Map<string, number>();
  return body.rows.map((raw, i) => {
    const row = body.startRow + i;
    const r = check(raw);
    const key = ROW_KEY[kind](raw);
    const result: ImportRowResult = { row, key, status: r.errors.length ? "error" : "create", errors: [...r.errors], warnings: [...r.warnings] };
    if (key && seen.has(key)) {
      result.status = "error";
      result.errors.push(`Listed twice in this file (first on row ${seen.get(key)}).`);
    } else if (key) seen.set(key, row);
    return { result, value: r.value };
  });
}

async function existing(db: D1Database, sql: string, values: string[]): Promise<Set<string>> {
  if (!values.length) return new Set();
  const { results } = await db.prepare(sql).bind(JSON.stringify([...new Set(values)])).all<{ v: string }>();
  return new Set(results.map((r) => r.v.toLowerCase()));
}

const TAKEN_SQL = `SELECT address AS v FROM mailboxes WHERE address IN (SELECT value FROM json_each(?1))
  UNION SELECT address AS v FROM mailbox_aliases WHERE address IN (SELECT value FROM json_each(?1))`;

function guardCommit(body: Body) {
  if (!body.dryRun && body.rows.length > IMPORT_CHUNK) {
    throw new HTTPException(400, { message: `Commit at most ${IMPORT_CHUNK} rows per request; the import wizard splits bigger files automatically.` });
  }
}

const respond = (c: Context<AppEnv>, dryRun: boolean, checked: Checked<unknown>[]) => {
  const results = checked.map((x) => x.result);
  return c.json({ dryRun, results, counts: countImport(results) } satisfies ImportResponse);
};

// ---- Users ---------------------------------------------------------------------

adminImportRoutes.post("/users", async (c) => {
  const body = await parseBody(c, zImport);
  guardCommit(body);
  const db = c.env.DB;
  const actor = c.get("user");
  const checked = firstPass("users", body, checkUserRow);
  const values = checked.flatMap((x) => (x.value ? [x.value] : []));
  const users = await existing(db, "SELECT email AS v FROM users WHERE email IN (SELECT value FROM json_each(?))", values.map((v) => v.email));
  const taken = await existing(db, TAKEN_SQL, values.flatMap((v) => (v.mailbox ? [v.mailbox] : [])));
  const mailboxSeen = new Map<string, number>();
  const zProfile = zProfilePatch.pick({ jobTitle: true, phone: true, department: true, timezone: true });
  for (const x of checked) {
    if (!x.value || x.result.status === "error") continue;
    const v = x.value;
    // The same rules as editing a profile (single line, phone characters, known time zone).
    const profile = zProfile.safeParse({ jobTitle: v.jobTitle, phone: v.phone, department: v.department, timezone: v.timezone });
    if (!profile.success) {
      x.result.status = "error";
      x.result.errors.push(...profile.error.issues.map((i) => `${String(i.path[0] ?? "Profile")}: ${i.message}`));
    } else if (v.role === "owner" && actor.role !== "owner") {
      x.result.status = "error";
      x.result.errors.push("Only owners can add owners.");
    } else if (users.has(v.email)) {
      x.result.status = "skip";
      x.result.warnings = ["Already a user; left unchanged."];
    } else if (v.mailbox && taken.has(v.mailbox)) {
      x.result.status = "error";
      x.result.errors.push(`The address ${v.mailbox} is already in use.`);
    } else if (v.mailbox && mailboxSeen.has(v.mailbox)) {
      x.result.status = "error";
      x.result.errors.push(`The mailbox ${v.mailbox} is also on row ${mailboxSeen.get(v.mailbox)}.`);
    }
    if (v.mailbox && x.result.status === "create") mailboxSeen.set(v.mailbox, x.result.row);
  }
  if (body.dryRun) return respond(c, true, checked);

  const audits: AuditEntry[] = [];
  const events: QueuedEvent[] = [];
  for (const x of checked) {
    if (x.result.status !== "create" || !x.value) continue;
    const v = x.value;
    try {
      // Checked again right before creating, in case an earlier row (or someone else) just took it.
      if (v.mailbox && (await addressTaken(db, v.mailbox))) throw new Error(`The address ${v.mailbox} is already in use.`);
      const id = await insertUser(db, { email: v.email, name: v.name, role: v.role, status: "invited" });
      if (v.jobTitle || v.phone || v.department || v.timezone) {
        await db.prepare("UPDATE users SET job_title = ?, phone = ?, department = ?, timezone = ? WHERE id = ?").bind(v.jobTitle, v.phone, v.department, v.timezone, id).run();
      }
      const mailboxId = v.mailbox ? await ensureMailbox(db, { address: v.mailbox, displayName: v.name, type: "personal", ownerId: id }) : null;
      const url = await issueToken(c.env, id, "invite", actor.id, 24 * 7);
      if (v.sendInvite) {
        const emailed = await emailInvite(c.env, v.email, url, actor.name || actor.email, v.name).catch(() => false);
        if (!emailed) x.result.warnings.push("Invite email couldn't be sent; resend it from Users.");
      }
      x.result.done = true;
      audits.push({ action: "user.invited", targetType: "user", targetId: id, meta: { email: v.email, role: v.role, mailboxId, via: "import", emailed: v.sendInvite } });
      events.push({ type: "user.created", data: { id, email: v.email, name: v.name, role: v.role, status: "invited", via: "import" } });
    } catch (err) {
      const message = err instanceof Error && /in use/.test(err.message) ? err.message : "Couldn't create this user. Nothing was saved for this row.";
      if (!(err instanceof Error && /in use/.test(err.message))) console.error("import user failed", v.email, err);
      x.result.status = "error";
      x.result.errors.push(message);
    }
  }
  audits.push({ action: "user.import", targetType: "user", meta: { rows: body.rows.length, startRow: body.startRow, counts: countImport(checked.map((x) => x.result)) } });
  await auditMany(c, audits);
  emitFromRequest(c, events);
  return respond(c, false, checked);
});

// ---- Mailboxes -----------------------------------------------------------------

adminImportRoutes.post("/mailboxes", async (c) => {
  const body = await parseBody(c, zImport);
  guardCommit(body);
  const db = c.env.DB;
  const checked = firstPass("mailboxes", body, checkMailboxRow);
  const values = checked.flatMap((x) => (x.value ? [x.value] : []));
  const taken = await existing(db, TAKEN_SQL, values.map((v) => v.address));
  const memberEmails = values.flatMap((v) => v.members.map((m) => m.email));
  const { results: people } = memberEmails.length
    ? await db.prepare("SELECT id, email FROM users WHERE email IN (SELECT value FROM json_each(?))").bind(JSON.stringify([...new Set(memberEmails)])).all<{ id: string; email: string }>()
    : { results: [] as { id: string; email: string }[] };
  const userId = new Map(people.map((p) => [p.email.toLowerCase(), p.id]));
  for (const x of checked) {
    if (!x.value || x.result.status === "error") continue;
    if (taken.has(x.value.address)) {
      x.result.status = "skip";
      x.result.warnings = ["Already exists; left unchanged."];
      continue;
    }
    const unknown = x.value.members.filter((m) => !userId.has(m.email)).map((m) => m.email);
    if (unknown.length) x.result.warnings.push(`No user for ${unknown.join(", ")}; they'll be left out. Import or invite them first.`);
  }
  if (body.dryRun) return respond(c, true, checked);

  const audits: AuditEntry[] = [];
  const events: QueuedEvent[] = [];
  for (const x of checked) {
    if (x.result.status !== "create" || !x.value) continue;
    const v = x.value;
    try {
      if (await addressTaken(db, v.address)) {
        x.result.status = "skip";
        x.result.warnings = ["Already exists; left unchanged."];
        continue;
      }
      const id = await ensureMailbox(db, { address: v.address, name: v.name, displayName: v.displayName, type: v.type });
      const members = v.members.filter((m) => userId.has(m.email));
      if (members.length) {
        const t = now();
        await db.batch(
          members.map((m) =>
            db
              .prepare(`INSERT INTO mailbox_members (mailbox_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(mailbox_id, user_id) DO UPDATE SET role = excluded.role`)
              .bind(id, userId.get(m.email)!, m.access, t),
          ),
        );
      }
      x.result.done = true;
      audits.push({ action: "mailbox.created", targetType: "mailbox", targetId: id, meta: { address: v.address, type: v.type, members: members.length, via: "import" } });
      events.push({ type: "mailbox.created", data: { id, address: v.address, type: v.type, via: "import" } });
    } catch (err) {
      console.error("import mailbox failed", v.address, err);
      x.result.status = "error";
      x.result.errors.push("Couldn't create this mailbox. Try again.");
    }
  }
  audits.push({ action: "mailbox.import", targetType: "mailbox", meta: { rows: body.rows.length, startRow: body.startRow, counts: countImport(checked.map((x) => x.result)) } });
  await auditMany(c, audits);
  emitFromRequest(c, events);
  return respond(c, false, checked);
});

// ---- Aliases -------------------------------------------------------------------

adminImportRoutes.post("/aliases", async (c) => {
  const body = await parseBody(c, zImport);
  guardCommit(body);
  const db = c.env.DB;
  const checked = firstPass("aliases", body, checkAliasRow);
  const values = checked.flatMap((x) => (x.value ? [x.value] : []));
  const json = (list: string[]) => JSON.stringify([...new Set(list)]);
  const [{ results: boxes }, { results: aliasRows }] = await Promise.all([
    db
      .prepare("SELECT id, address FROM mailboxes WHERE is_system = 0 AND address IN (SELECT value FROM json_each(?))")
      .bind(json(values.map((v) => v.mailbox)))
      .all<{ id: string; address: string }>(),
    db
      .prepare(
        `SELECT a.address, m.address AS mailbox FROM mailbox_aliases a JOIN mailboxes m ON m.id = a.mailbox_id WHERE a.address IN (SELECT value FROM json_each(?))
         UNION SELECT address, NULL FROM mailboxes WHERE address IN (SELECT value FROM json_each(?))`,
      )
      .bind(json(values.map((v) => v.address)), json(values.map((v) => v.address)))
      .all<{ address: string; mailbox: string | null }>(),
  ]);
  const mailboxId = new Map(boxes.map((b) => [b.address.toLowerCase(), b.id]));
  const owner = new Map(aliasRows.map((a) => [a.address.toLowerCase(), a.mailbox?.toLowerCase() ?? null]));
  for (const x of checked) {
    if (!x.value || x.result.status === "error") continue;
    const v = x.value;
    if (!mailboxId.has(v.mailbox)) {
      x.result.status = "error";
      x.result.errors.push(`There's no mailbox ${v.mailbox}. Create it first.`);
    } else if (owner.has(v.address)) {
      const current = owner.get(v.address);
      if (current === v.mailbox) {
        x.result.status = "skip";
        x.result.warnings = ["Already set up; left unchanged."];
      } else {
        x.result.status = "error";
        x.result.errors.push(current ? `${v.address} already delivers to ${current}.` : `${v.address} is already a mailbox.`);
      }
    }
  }
  if (body.dryRun) return respond(c, true, checked);

  const audits: AuditEntry[] = [];
  const t = now();
  for (const x of checked) {
    if (x.result.status !== "create" || !x.value) continue;
    const v = x.value;
    try {
      if (await addressTaken(db, v.address)) throw new Error("taken");
      const id = mailboxId.get(v.mailbox)!;
      await db.prepare("INSERT INTO mailbox_aliases (address, mailbox_id, created_at) VALUES (?, ?, ?)").bind(v.address, id, t).run();
      x.result.done = true;
      audits.push({ action: "mailbox.alias_added", targetType: "mailbox", targetId: id, meta: { address: v.address, via: "import" } });
    } catch (err) {
      if ((err as Error).message !== "taken") console.error("import alias failed", v.address, err);
      x.result.status = "error";
      x.result.errors.push((err as Error).message === "taken" ? `${v.address} is already in use.` : "Couldn't add this alias. Try again.");
    }
  }
  audits.push({ action: "mailbox.alias_import", targetType: "mailbox", meta: { rows: body.rows.length, startRow: body.startRow, counts: countImport(checked.map((x) => x.result)) } });
  await auditMany(c, audits);
  return respond(c, false, checked);
});
