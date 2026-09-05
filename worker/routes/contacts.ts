import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Contact } from "@shared/types";
import type { AppEnv } from "../env";
import { likeEscape } from "../lib/search";
import { clampInt, newId, now } from "../lib/util";
import { parseBody, zEmail } from "../lib/validate";

export const contactRoutes = new Hono<AppEnv>();

interface ContactRow {
  id: string;
  email: string;
  name: string;
  company: string;
  notes: string;
  times_contacted: number;
  last_contacted_at: string | null;
}

const toContact = (r: ContactRow): Contact => ({
  id: r.id,
  email: r.email,
  name: r.name,
  company: r.company,
  notes: r.notes,
  timesContacted: r.times_contacted,
  lastContactedAt: r.last_contacted_at,
});

/**
 * Directory search used by recipient autocomplete and the Contacts page.
 * `saved=1` limits to contacts people explicitly saved; otherwise auto-collected ones are included.
 */
contactRoutes.get("/", async (c) => {
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const limit = clampInt(c.req.query("limit"), 1, 200, 50);
  const savedOnly = c.req.query("saved") === "1";
  const pat = `%${likeEscape(q)}%`;
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM contacts
     WHERE (? = '' OR email LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR company LIKE ? ESCAPE '\\')
       AND (? = 0 OR is_saved = 1)
     ORDER BY is_saved DESC, times_contacted DESC, last_contacted_at DESC LIMIT ?`,
  )
    .bind(q, pat, pat, pat, savedOnly ? 1 : 0, limit)
    .all<ContactRow>();

  // Include teammates and shared mailboxes so internal addresses autocomplete too.
  let internal: Contact[] = [];
  if (q && !savedOnly) {
    const { results: people } = await c.env.DB.prepare(
      `SELECT address AS email, display_name AS name FROM mailboxes WHERE is_active = 1 AND is_system = 0 AND (address LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
       UNION SELECT email, name FROM users WHERE status = 'active' AND (email LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\') LIMIT 10`,
    )
      .bind(pat, pat, pat, pat)
      .all<{ email: string; name: string }>();
    internal = people.map((p) => ({
      id: `internal:${p.email}`,
      email: p.email,
      name: p.name,
      company: "Internal",
      notes: "",
      timesContacted: 0,
      lastContactedAt: null,
    }));
  }
  const seen = new Set<string>();
  const merged = [...internal, ...results.map(toContact)].filter((x) => !seen.has(x.email) && (seen.add(x.email), true));
  return c.json(merged.slice(0, limit));
});

const zContact = z.object({
  email: zEmail,
  name: z.string().trim().max(200).default(""),
  company: z.string().trim().max(200).default(""),
  notes: z.string().max(5000).default(""),
});

contactRoutes.post("/", async (c) => {
  const body = await parseBody(c, zContact);
  const t = now();
  const row = await c.env.DB.prepare(
    `INSERT INTO contacts (id, email, name, company, notes, is_saved, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(email) DO UPDATE SET name = excluded.name, company = excluded.company, notes = excluded.notes, is_saved = 1, updated_at = excluded.updated_at
     RETURNING *`,
  )
    .bind(newId(), body.email, body.name, body.company, body.notes, t, t)
    .first<ContactRow>();
  return c.json(toContact(row!), 201);
});

contactRoutes.patch("/:id", async (c) => {
  const body = await parseBody(c, zContact.partial());
  const row = await c.env.DB.prepare(
    `UPDATE contacts SET email = COALESCE(?, email), name = COALESCE(?, name), company = COALESCE(?, company),
       notes = COALESCE(?, notes), is_saved = 1, updated_at = ? WHERE id = ? RETURNING *`,
  )
    .bind(body.email ?? null, body.name ?? null, body.company ?? null, body.notes ?? null, now(), c.req.param("id"))
    .first<ContactRow>();
  if (!row) throw new HTTPException(404, { message: "Contact not found" });
  return c.json(toContact(row));
});

contactRoutes.delete("/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM contacts WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});
