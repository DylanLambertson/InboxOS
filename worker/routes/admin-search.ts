import { Hono } from "hono";
import { mailDomains } from "@shared/brand";
import type { AdminSearchResults } from "@shared/admin";
import type { AppEnv } from "../env";
import { roleSql } from "../lib/roles";
import { likeEscape } from "../lib/search";
import { getBrand } from "../lib/settings";

/** Quick lookup for the command palette: people, mailboxes, aliases and domains. Read-only. */
export const adminSearchRoutes = new Hono<AppEnv>();

const LIMIT = 6;

adminSearchRoutes.get("/", async (c) => {
  const q = (c.req.query("q") ?? "").trim().toLowerCase().slice(0, 100);
  const empty: AdminSearchResults = { users: [], mailboxes: [], aliases: [], domains: [] };
  if (!q) return c.json(empty);
  const db = c.env.DB;
  // Prefix matches rank first; anywhere-matches fill the rest.
  const any = `%${likeEscape(q)}%`;
  const start = `${likeEscape(q)}%`;
  const [users, mailboxes, aliases, brand] = await Promise.all([
    db
      .prepare(
        `SELECT u.id, u.name, u.email, ${roleSql("u")} AS role, u.status FROM users u
         WHERE u.email LIKE ?1 ESCAPE '\\' OR u.name LIKE ?1 ESCAPE '\\'
         ORDER BY (u.email LIKE ?2 ESCAPE '\\' OR u.name LIKE ?2 ESCAPE '\\') DESC, u.status = 'active' DESC, u.email LIMIT ?3`,
      )
      .bind(any, start, LIMIT)
      .all<AdminSearchResults["users"][number]>(),
    db
      .prepare(
        `SELECT id, address, COALESCE(NULLIF(name, ''), display_name) AS name, type FROM mailboxes
         WHERE is_system = 0 AND is_active = 1 AND (address LIKE ?1 ESCAPE '\\' OR name LIKE ?1 ESCAPE '\\' OR display_name LIKE ?1 ESCAPE '\\')
         ORDER BY address LIKE ?2 ESCAPE '\\' DESC, address LIMIT ?3`,
      )
      .bind(any, start, LIMIT)
      .all<AdminSearchResults["mailboxes"][number]>(),
    db
      .prepare(
        `SELECT a.address, a.mailbox_id AS mailboxId, m.address AS mailbox FROM mailbox_aliases a JOIN mailboxes m ON m.id = a.mailbox_id
         WHERE m.is_system = 0 AND a.address LIKE ?1 ESCAPE '\\' ORDER BY a.address LIKE ?2 ESCAPE '\\' DESC, a.address LIMIT ?3`,
      )
      .bind(any, start, LIMIT)
      .all<AdminSearchResults["aliases"][number]>(),
    getBrand(db),
  ]);
  const domains = mailDomains(brand)
    .filter((d) => d.includes(q))
    .slice(0, LIMIT)
    .map((name) => ({ name, primary: name === brand.primaryDomain.toLowerCase() }));
  return c.json({ users: users.results, mailboxes: mailboxes.results, aliases: aliases.results, domains } satisfies AdminSearchResults);
});
