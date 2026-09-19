-- Snooze: a message sits in the 'snoozed' folder until snoozed_until, then returns to the inbox unread.
ALTER TABLE messages ADD COLUMN snoozed_until TEXT;
CREATE INDEX idx_messages_snoozed ON messages(snoozed_until) WHERE snoozed_until IS NOT NULL;
