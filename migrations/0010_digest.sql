-- Unread-mail digest: every few hours, a short email to a person's verified
-- personal address listing unread mail in their mailboxes.
ALTER TABLE users ADD COLUMN personal_email TEXT COLLATE NOCASE;   -- only ever a verified address
ALTER TABLE users ADD COLUMN personal_email_verified_at TEXT;
ALTER TABLE users ADD COLUMN digest_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN digest_hours INTEGER NOT NULL DEFAULT 5;
ALTER TABLE users ADD COLUMN digest_last_at TEXT;                  -- start of the next digest's window
ALTER TABLE users ADD COLUMN digest_next_at TEXT;                  -- when the next one is due
CREATE INDEX idx_users_digest_due ON users(digest_next_at) WHERE digest_enabled = 1;

-- Allow a 'verify_email' token (the pending address waits in tokens.data).
-- SQLite can't alter a CHECK constraint, so the table is rebuilt. Nothing references it.
CREATE TABLE tokens_new (
  id          TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('invite','reset','oauth_state','verify_email')),
  data        TEXT,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL
);
INSERT INTO tokens_new (id, user_id, type, data, expires_at, used_at, created_by, created_at)
  SELECT id, user_id, type, data, expires_at, used_at, created_by, created_at FROM tokens;
DROP TABLE tokens;
ALTER TABLE tokens_new RENAME TO tokens;
