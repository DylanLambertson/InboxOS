-- Security center: every sign-in attempt and its outcome, for history, alerts and investigations.
-- Not a foreign key on users: history must survive the account being deleted.
CREATE TABLE login_events (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,                 -- NULL when the email matched no account
  email       TEXT,
  outcome     TEXT NOT NULL,        -- success | failed | locked | 2fa_failed | blocked
  method      TEXT NOT NULL,        -- password | password+2fa | google | session
  reason      TEXT,
  ip          TEXT,
  user_agent  TEXT,
  device      TEXT,                 -- "Chrome on macOS": what new-device alerts compare
  country     TEXT,                 -- ISO 3166 code from Cloudflare, when known
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_login_events_user ON login_events(user_id, created_at);
CREATE INDEX idx_login_events_created ON login_events(created_at);
