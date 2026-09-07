-- Separate the mailbox's internal label (sidebar, lists) from the sender name
-- recipients see in the From line (display_name). Existing mailboxes keep their
-- current label by copying the sender name.
ALTER TABLE mailboxes ADD COLUMN name TEXT NOT NULL DEFAULT '';
UPDATE mailboxes SET name = display_name WHERE name = '';
