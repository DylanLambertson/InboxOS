import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../env";
import { audit } from "../lib/audit";
import { likeEscape } from "../lib/search";
import { clampInt, now } from "../lib/util";
import { parseBody, zEmail } from "../lib/validate";

/**
 * Admin → Unsubscribes: everyone on the do-not-email list (unsubscribed, bounced,
 * complained or added by hand), with search, filters, counts and a CSV export.
 */
export const adminSuppressionRoutes = new Hono<AppEnv>();

const REASONS = ["unsubscribed", "bounced", "complained", "manual"] as const;

interface Row {
  email: string;
  reason: (typeof REASONS)[number];
  detail: string | null;
  created_at: string;
  name: string | null;
  company: string | null;
}

/** WHERE clause + args for the list and the export, from ?q= and ?reason=. */
function filters(q: string | undefined, reason: string | undefined) {
  const where: string[] = [];
  const args: unknown[] = [];
  const query = q?.trim().toLowerCase();
  if (query) {
    const like = `%${likeEscape(query)}%`;
    where.push("(s.email LIKE ? ESCAPE '\\' OR lower(c.name) LIKE ? ESCAPE '\\' OR lower(c.company) LIKE ? ESCAPE '\\' OR lower(COALESCE(s.detail,'')) LIKE ? ESCAPE '\\')");
    args.push(like, like, like, like);
  }
  if (reason && (REASONS as readonly string[]).includes(reason)) {
    where.push("s.reason = ?");
    args.push(reason);
  }
  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", args };
}

const SELECT = `SELECT s.email, s.reason, s.detail, s.created_at, c.name, c.company
  FROM suppressions s LEFT JOIN contacts c ON c.email = s.email`;

const toItem = (r: Row) => ({
  email: r.email,
  reason: r.reason,
  detail: r.detail,
  createdAt: r.created_at,
  name: r.name || null,
  company: r.company || null,
});

adminSuppressionRoutes.get("/", async (c) => {
  const limit = clampInt(c.req.query("limit"), 1, 200, 50);
  const offset = clampInt(c.req.query("offset"), 0, 1_000_000, 0);
  const f = filters(c.req.query("q"), c.req.query("reason"));
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const db = c.env.DB;
  const [{ results }, total, counts] = await Promise.all([
    db.prepare(`${SELECT} ${f.sql} ORDER BY s.created_at DESC LIMIT ? OFFSET ?`).bind(...f.args, limit, offset).all<Row>(),
    db.prepare(`SELECT COUNT(*) AS n FROM suppressions s LEFT JOIN contacts c ON c.email = s.email ${f.sql}`).bind(...f.args).first<{ n: number }>(),
    db
      .prepare(
        `SELECT reason, COUNT(*) AS n, SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS recent FROM suppressions GROUP BY reason`,
      )
      .bind(since)
      .all<{ reason: string; n: number; recent: number }>(),
  ]);
  const byReason = Object.fromEntries(REASONS.map((r) => [r, 0])) as Record<(typeof REASONS)[number], number>;
  let last30 = 0;
  for (const row of counts.results) {
    if (row.reason in byReason) byReason[row.reason as keyof typeof byReason] = row.n;
    last30 += row.recent ?? 0;
  }
  return c.json({ items: results.map(toItem), total: total?.n ?? 0, counts: { ...byReason, last30Days: last30 } });
});

/** The whole (filtered) list as a spreadsheet. */
adminSuppressionRoutes.get("/export.csv", async (c) => {
  const f = filters(c.req.query("q"), c.req.query("reason"));
  const { results } = await c.env.DB.prepare(`${SELECT} ${f.sql} ORDER BY s.created_at DESC LIMIT 50000`).bind(...f.args).all<Row>();
  // Quote every cell, and defuse spreadsheet formulas (=, +, -, @) in user-supplied text.
  const cell = (v: string | null) => {
    const s = (v ?? "").replace(/"/g, '""');
    return `"${/^[=+\-@\t\r]/.test(s) ? `'${s}` : s}"`;
  };
  const lines = [
    ["Email", "Name", "Company", "Reason", "Detail", "Date (UTC)"].map(cell).join(","),
    ...results.map((r) => [r.email, r.name, r.company, r.reason, r.detail, r.created_at].map(cell).join(",")),
  ];
  await audit(c, { action: "suppression.exported", targetType: "contact", meta: { rows: results.length } });
  return new Response(lines.join("\r\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="do-not-email-${now().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});

/** Add someone by hand (e.g. they asked by phone or reply). */
adminSuppressionRoutes.post("/", async (c) => {
  const body = await parseBody(c, z.object({ email: zEmail, note: z.string().trim().max(300).optional() }));
  const res = await c.env.DB.prepare("INSERT INTO suppressions (email, reason, detail, created_at) VALUES (?, 'manual', ?, ?) ON CONFLICT(email) DO NOTHING")
    .bind(body.email, body.note || `Added by ${c.get("user").name || c.get("user").email}`, now())
    .run();
  if (!res.meta.changes) throw new HTTPException(409, { message: `${body.email} is already on the list.` });
  await audit(c, { action: "suppression.added", targetType: "contact", targetId: body.email });
  return c.json({ ok: true }, 201);
});

adminSuppressionRoutes.delete("/:email", async (c) => {
  const email = decodeURIComponent(c.req.param("email")).toLowerCase();
  const res = await c.env.DB.prepare("DELETE FROM suppressions WHERE email = ?").bind(email).run();
  if (!res.meta.changes) throw new HTTPException(404, { message: "Not on the list" });
  await audit(c, { action: "suppression.removed", targetType: "contact", targetId: email });
  return c.json({ ok: true });
});
