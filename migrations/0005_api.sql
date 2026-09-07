-- External API: keys for other services and MCP clients,
-- a suppression list for unsubscribes/bounces, and richer contact fields for personalization.

CREATE TABLE api_keys (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,   -- SHA-256 of the key; the key itself is shown once
  prefix        TEXT NOT NULL,          -- first characters, so people can tell keys apart
  scopes        TEXT NOT NULL DEFAULT '["send"]',  -- JSON: send | contacts | read
  mailbox_ids   TEXT NOT NULL DEFAULT '[]',        -- JSON; empty = every mailbox
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  last_used_at  TEXT,
  revoked_at    TEXT,
  created_at    TEXT NOT NULL
);

-- Addresses we must not send outreach to. Bounces and complaints also block transactional mail.
CREATE TABLE suppressions (
  email       TEXT PRIMARY KEY COLLATE NOCASE,
  reason      TEXT NOT NULL CHECK (reason IN ('unsubscribed','bounced','complained','manual')),
  detail      TEXT,
  created_at  TEXT NOT NULL
);

ALTER TABLE contacts ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE contacts ADD COLUMN website TEXT NOT NULL DEFAULT '';
ALTER TABLE contacts ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
