-- Shared-inbox collaboration: per-conversation status and assignee, internal notes,
-- @mentions, an activity trail and a short-lived "someone is replying" marker.
-- A conversation is (mailbox_id, thread_id); rows are created lazily, so a missing row means open + unassigned.

CREATE TABLE conversations (
  mailbox_id   TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  thread_id    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','closed')),
  assignee_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (mailbox_id, thread_id)
);
CREATE INDEX idx_conversations_assignee ON conversations(assignee_id, status) WHERE assignee_id IS NOT NULL;
CREATE INDEX idx_conversations_status ON conversations(mailbox_id, status);

-- Team-only comments. Never emailed.
CREATE TABLE conversation_notes (
  id          TEXT PRIMARY KEY,
  mailbox_id  TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  thread_id   TEXT NOT NULL,
  author_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  edited_at   TEXT
);
CREATE INDEX idx_notes_thread ON conversation_notes(mailbox_id, thread_id, created_at);

-- Who a note @mentions; seen_at is set when they open the conversation.
CREATE TABLE conversation_mentions (
  note_id     TEXT NOT NULL REFERENCES conversation_notes(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mailbox_id  TEXT NOT NULL,
  thread_id   TEXT NOT NULL,
  seen_at     TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (note_id, user_id)
);
CREATE INDEX idx_mentions_user ON conversation_mentions(user_id, seen_at);
CREATE INDEX idx_mentions_thread ON conversation_mentions(mailbox_id, thread_id, user_id);

-- Activity trail: assigned / unassigned / status / note / note_deleted. actor_id NULL = the system (e.g. a reply reopened it).
CREATE TABLE conversation_events (
  id              TEXT PRIMARY KEY,
  mailbox_id      TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  thread_id       TEXT NOT NULL,
  actor_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  type            TEXT NOT NULL,
  target_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  value           TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_conv_events_thread ON conversation_events(mailbox_id, thread_id, created_at);

-- "Priya is replying…": refreshed by the open composer, ignored once expires_at passes (no cron needed).
CREATE TABLE conversation_presence (
  mailbox_id  TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  thread_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  PRIMARY KEY (mailbox_id, thread_id, user_id)
);
CREATE INDEX idx_presence_expires ON conversation_presence(expires_at);
