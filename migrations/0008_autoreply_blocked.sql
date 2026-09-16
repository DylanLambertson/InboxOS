-- Vacation auto-reply per mailbox, and per-mailbox blocked senders.

-- JSON: {"enabled":bool,"subject":string,"message":string,"startsAt":iso|null,"endsAt":iso|null}
ALTER TABLE mailboxes ADD COLUMN autoreply_json TEXT;

-- One auto-reply per sender per few days, so a back-and-forth never loops.
CREATE TABLE autoreply_log (
  mailbox_id  TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  sender      TEXT NOT NULL COLLATE NOCASE,
  sent_at     TEXT NOT NULL,
  PRIMARY KEY (mailbox_id, sender)
);

-- Mail from these goes straight to Spam. `pattern` is a full address or "@domain".
CREATE TABLE blocked_senders (
  mailbox_id  TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  pattern     TEXT NOT NULL COLLATE NOCASE,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (mailbox_id, pattern)
);
