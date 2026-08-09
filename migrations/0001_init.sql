-- Core schema. All timestamps are ISO-8601 UTC strings; ids are random strings.

CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name            TEXT NOT NULL DEFAULT '',
  password_hash   TEXT,
  role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  status          TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('active','invited','disabled')),
  avatar_color    TEXT NOT NULL DEFAULT '#64748b',
  totp_secret     TEXT,
  totp_enabled    INTEGER NOT NULL DEFAULT 0,
  recovery_codes  TEXT,               -- JSON array of SHA-256 hashes
  google_sub      TEXT UNIQUE,
  signature_html  TEXT NOT NULL DEFAULT '',
  preferences     TEXT NOT NULL DEFAULT '{}',
  failed_logins   INTEGER NOT NULL DEFAULT 0,
  locked_until    TEXT,
  last_login_at   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,     -- SHA-256 of the cookie token
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mfa_pending   INTEGER NOT NULL DEFAULT 0,
  ip            TEXT,
  user_agent    TEXT,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Single-use tokens: invites, password resets, OAuth state.
CREATE TABLE tokens (
  id          TEXT PRIMARY KEY,       -- SHA-256 of the token
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('invite','reset','oauth_state')),
  data        TEXT,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE mailboxes (
  id              TEXT PRIMARY KEY,
  address         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name    TEXT NOT NULL DEFAULT '',
  type            TEXT NOT NULL DEFAULT 'personal' CHECK (type IN ('personal','shared')),
  color           TEXT NOT NULL DEFAULT '#64748b',
  signature_html  TEXT NOT NULL DEFAULT '',
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE mailbox_aliases (
  address     TEXT PRIMARY KEY COLLATE NOCASE,
  mailbox_id  TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL
);

CREATE TABLE mailbox_members (
  mailbox_id  TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('owner','editor','viewer')),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (mailbox_id, user_id)
);
CREATE INDEX idx_members_user ON mailbox_members(user_id);

CREATE TABLE messages (
  id                TEXT PRIMARY KEY,
  mailbox_id        TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  thread_id         TEXT NOT NULL,
  direction         TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  folder            TEXT NOT NULL,
  status            TEXT NOT NULL,
  from_addr         TEXT NOT NULL DEFAULT '',
  from_name         TEXT NOT NULL DEFAULT '',
  to_json           TEXT NOT NULL DEFAULT '[]',
  cc_json           TEXT NOT NULL DEFAULT '[]',
  bcc_json          TEXT NOT NULL DEFAULT '[]',
  reply_to_json     TEXT NOT NULL DEFAULT '[]',
  subject           TEXT NOT NULL DEFAULT '',
  subject_norm      TEXT NOT NULL DEFAULT '',
  snippet           TEXT NOT NULL DEFAULT '',
  text_body         TEXT NOT NULL DEFAULT '',
  html_key          TEXT,               -- R2 key of the HTML body
  headers_json      TEXT NOT NULL DEFAULT '{}',
  message_id_header TEXT,
  in_reply_to       TEXT,
  references_header TEXT,
  is_read           INTEGER NOT NULL DEFAULT 0,
  is_starred        INTEGER NOT NULL DEFAULT 0,
  has_attachments   INTEGER NOT NULL DEFAULT 0,
  size              INTEGER NOT NULL DEFAULT 0,
  priority          TEXT NOT NULL DEFAULT 'normal',
  resend_id         TEXT,
  scheduled_at      TEXT,
  sent_at           TEXT,
  error             TEXT,
  open_count        INTEGER NOT NULL DEFAULT 0,
  click_count       INTEGER NOT NULL DEFAULT 0,
  compose_meta      TEXT,               -- JSON: mode, source message, etc. (drafts)
  created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  folder_before_trash TEXT,
  trashed_at        TEXT,
  date              TEXT NOT NULL,      -- display/sort date
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_messages_folder ON messages(mailbox_id, folder, date DESC);
CREATE INDEX idx_messages_thread ON messages(mailbox_id, thread_id, date);
CREATE INDEX idx_messages_msgid ON messages(mailbox_id, message_id_header);
CREATE INDEX idx_messages_resend ON messages(resend_id);
CREATE INDEX idx_messages_sched ON messages(status, scheduled_at);
CREATE INDEX idx_messages_starred ON messages(mailbox_id, is_starred, date DESC);
CREATE INDEX idx_messages_sent_at ON messages(direction, sent_at);
CREATE INDEX idx_messages_subject ON messages(mailbox_id, subject_norm, date);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  message_id UNINDEXED, subject, from_text, to_text, body,
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE attachments (
  id            TEXT PRIMARY KEY,
  message_id    TEXT REFERENCES messages(id) ON DELETE CASCADE,  -- NULL until attached to a draft
  mailbox_id    TEXT NOT NULL,
  filename      TEXT NOT NULL,
  content_type  TEXT NOT NULL DEFAULT 'application/octet-stream',
  size          INTEGER NOT NULL DEFAULT 0,
  r2_key        TEXT NOT NULL,
  content_id    TEXT,
  inline        INTEGER NOT NULL DEFAULT 0,
  uploaded_by   TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_attachments_message ON attachments(message_id);

CREATE TABLE labels (
  id          TEXT PRIMARY KEY,
  mailbox_id  TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#64748b',
  created_at  TEXT NOT NULL,
  UNIQUE (mailbox_id, name)
);

CREATE TABLE message_labels (
  message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  label_id    TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, label_id)
);
CREATE INDEX idx_message_labels_label ON message_labels(label_id);

CREATE TABLE email_events (
  id          TEXT PRIMARY KEY,
  message_id  TEXT REFERENCES messages(id) ON DELETE SET NULL,
  resend_id   TEXT,
  type        TEXT NOT NULL,
  recipient   TEXT,
  detail      TEXT,
  payload     TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_events_message ON email_events(message_id, created_at);
CREATE INDEX idx_events_created ON email_events(created_at DESC);
CREATE INDEX idx_events_type ON email_events(type, created_at DESC);

CREATE TABLE webhook_receipts (
  id          TEXT PRIMARY KEY,       -- svix-id
  created_at  TEXT NOT NULL
);

CREATE TABLE audit_logs (
  id           TEXT PRIMARY KEY,
  actor_id     TEXT,
  actor_email  TEXT,
  action       TEXT NOT NULL,
  target_type  TEXT,
  target_id    TEXT,
  ip           TEXT,
  user_agent   TEXT,
  meta         TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_actor ON audit_logs(actor_id, created_at DESC);

CREATE TABLE contacts (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name              TEXT NOT NULL DEFAULT '',
  company           TEXT NOT NULL DEFAULT '',
  notes             TEXT NOT NULL DEFAULT '',
  times_contacted   INTEGER NOT NULL DEFAULT 0,
  last_contacted_at TEXT,
  is_saved          INTEGER NOT NULL DEFAULT 0,  -- 0 = auto-collected
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  subject     TEXT NOT NULL DEFAULT '',
  html        TEXT NOT NULL DEFAULT '',
  scope       TEXT NOT NULL DEFAULT 'personal' CHECK (scope IN ('org','personal')),
  owner_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT
);

CREATE TABLE rate_limits (
  key           TEXT PRIMARY KEY,
  count         INTEGER NOT NULL,
  window_start  INTEGER NOT NULL
);
