import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Template } from "@shared/types";
import type { AppEnv } from "../env";
import { requireFeature, WRITES } from "../lib/features";
import { audit } from "../lib/audit";
import { isAdmin } from "../lib/session";
import { newId, now } from "../lib/util";
import { parseBody } from "../lib/validate";

export const templateRoutes = new Hono<AppEnv>();
templateRoutes.use("*", requireFeature("templates", { methods: WRITES }));

interface TemplateRow {
  id: string;
  name: string;
  subject: string;
  html: string;
  scope: "org" | "personal";
  owner_id: string | null;
  updated_at: string;
}

const toTemplate = (r: TemplateRow): Template => ({
  id: r.id,
  name: r.name,
  subject: r.subject,
  html: r.html,
  scope: r.scope,
  ownerId: r.owner_id,
  updatedAt: r.updated_at,
});

templateRoutes.get("/", async (c) => {
  const u = c.get("user");
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM templates WHERE scope = 'org' OR owner_id = ? ORDER BY scope, name COLLATE NOCASE",
  )
    .bind(u.id)
    .all<TemplateRow>();
  return c.json(results.map(toTemplate));
});

const zTemplate = z.object({
  name: z.string().trim().min(1).max(120),
  subject: z.string().max(998).default(""),
  html: z.string().max(500_000).default(""),
  scope: z.enum(["org", "personal"]).default("personal"),
});

templateRoutes.post("/", async (c) => {
  const body = await parseBody(c, zTemplate);
  const u = c.get("user");
  if (body.scope === "org" && !isAdmin(u)) throw new HTTPException(403, { message: "Only admins can create shared templates." });
  const id = newId();
  const t = now();
  await c.env.DB.prepare("INSERT INTO templates (id, name, subject, html, scope, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, body.name, body.subject, body.html, body.scope, u.id, t, t)
    .run();
  if (body.scope === "org") await audit(c, { action: "template.created", targetType: "template", targetId: id, meta: { name: body.name } });
  return c.json(toTemplate({ id, ...body, owner_id: u.id, updated_at: t }), 201);
});

async function editable(c: Context<AppEnv>) {
  const u = c.get("user");
  const row = await c.env.DB.prepare("SELECT * FROM templates WHERE id = ?").bind(c.req.param("id")).first<TemplateRow>();
  if (!row || (row.scope === "personal" && row.owner_id !== u.id)) throw new HTTPException(404, { message: "Template not found" });
  if (row.scope === "org" && !isAdmin(u)) throw new HTTPException(403, { message: "Only admins can edit shared templates." });
  return row;
}

templateRoutes.patch("/:id", async (c) => {
  const row = await editable(c);
  const body = await parseBody(c, zTemplate.partial());
  if (body.scope === "org" && !isAdmin(c.get("user"))) throw new HTTPException(403, { message: "Only admins can share templates." });
  const t = now();
  await c.env.DB.prepare("UPDATE templates SET name = ?, subject = ?, html = ?, scope = ?, updated_at = ? WHERE id = ?")
    .bind(body.name ?? row.name, body.subject ?? row.subject, body.html ?? row.html, body.scope ?? row.scope, t, row.id)
    .run();
  return c.json({ ok: true });
});

templateRoutes.delete("/:id", async (c) => {
  const row = await editable(c);
  await c.env.DB.prepare("DELETE FROM templates WHERE id = ?").bind(row.id).run();
  if (row.scope === "org") await audit(c, { action: "template.deleted", targetType: "template", targetId: row.id, meta: { name: row.name } });
  return c.json({ ok: true });
});
