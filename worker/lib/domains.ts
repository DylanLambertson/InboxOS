import { mailDomains } from "@shared/brand";
import { getBrand } from "./settings";
import { now } from "./util";

/**
 * Give mailboxes their address on every mail domain: hello@<one domain> gets
 * hello@<each other domain> as an alias, so it receives there and can send from
 * there. Only mailboxes already on one of the domains are touched; addresses that
 * already belong to another mailbox (or alias) are left alone.
 */
export async function syncDomainAliases(db: D1Database, mailboxId?: string): Promise<void> {
  const domains = mailDomains(await getBrand(db));
  if (domains.length < 2) return;
  const t = now();
  const inList = domains.map(() => "?").join(",");
  const local = "substr(m.address, 1, instr(m.address, '@'))";
  const domainOf = "lower(substr(m.address, instr(m.address, '@') + 1))";
  await db.batch(
    domains.map((d) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO mailbox_aliases (address, mailbox_id, created_at)
           SELECT ${local} || ?, m.id, ? FROM mailboxes m
           WHERE m.is_system = 0 AND ${domainOf} IN (${inList}) AND ${domainOf} != ?
             AND NOT EXISTS (SELECT 1 FROM mailboxes x WHERE x.address = ${local} || ?)
             ${mailboxId ? "AND m.id = ?" : ""}`,
        )
        .bind(d, t, ...domains, d, d, ...(mailboxId ? [mailboxId] : [])),
    ),
  );
}
