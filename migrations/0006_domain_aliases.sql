-- Multi-domain support: every mailbox gets its address on each additional mail
-- domain as an alias. The aliases are created by the app (worker/lib/domains.ts)
-- whenever a domain is added, so this migration only adds the lookup index.
CREATE INDEX IF NOT EXISTS idx_mailbox_aliases_mailbox ON mailbox_aliases(mailbox_id);
