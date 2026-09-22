-- Outlook/Gmail-style filters per mailbox, applied to incoming mail in `position` order.

CREATE TABLE mail_rules (
  id               TEXT PRIMARY KEY,
  mailbox_id       TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1,
  position         INTEGER NOT NULL DEFAULT 0,
  match            TEXT NOT NULL DEFAULT 'all' CHECK (match IN ('all','any')),
  conditions       TEXT NOT NULL DEFAULT '[]',   -- JSON RuleCondition[]
  actions          TEXT NOT NULL DEFAULT '[]',   -- JSON RuleAction[]
  stop_processing  INTEGER NOT NULL DEFAULT 0,
  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  hits             INTEGER NOT NULL DEFAULT 0,
  last_hit_at      TEXT
);
CREATE INDEX idx_mail_rules_mailbox ON mail_rules(mailbox_id, position);
