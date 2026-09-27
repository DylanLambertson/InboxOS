-- Retention policies, legal holds and eDiscovery exports.

-- Per-mailbox retention override. NULL = follow the org policy; 0 = keep forever.
ALTER TABLE mailboxes ADD COLUMN retention_days INTEGER;
ALTER TABLE mailboxes ADD COLUMN retention_scope TEXT CHECK (retention_scope IN ('all','archive'));

-- A hold targets one mailbox or one user (every mailbox they belong to).
-- No foreign keys on purpose: the record must outlive anything it points at.
CREATE TABLE legal_holds (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  reason            TEXT NOT NULL DEFAULT '',
  mailbox_id        TEXT,
  user_id           TEXT,
  target_label      TEXT NOT NULL DEFAULT '',   -- address / email when placed, kept for the record
  created_by        TEXT,
  created_by_email  TEXT,
  created_at        TEXT NOT NULL,
  released_at       TEXT,
  released_by_email TEXT,
  CHECK ((mailbox_id IS NULL) <> (user_id IS NULL))
);
CREATE INDEX idx_legal_holds_active ON legal_holds(released_at);

-- Mailboxes a user hold has covered, so removing the person from a mailbox doesn't release it.
CREATE TABLE legal_hold_mailboxes (
  hold_id     TEXT NOT NULL REFERENCES legal_holds(id) ON DELETE CASCADE,
  mailbox_id  TEXT NOT NULL,
  PRIMARY KEY (hold_id, mailbox_id)
);

-- Short-lived download links for eDiscovery exports. The message set is fixed when the link is made.
CREATE TABLE ediscovery_exports (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  criteria     TEXT NOT NULL,
  message_ids  TEXT NOT NULL,                 -- JSON array
  expires_at   TEXT NOT NULL,
  downloads    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);
