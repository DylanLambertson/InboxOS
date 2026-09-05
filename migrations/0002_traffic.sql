-- Org-wide traffic view: keep mail sent to addresses that have no mailbox.

-- System mailboxes are internal holding areas: never routed to, never listed, never shared.
ALTER TABLE mailboxes ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0;

-- Holds inbound mail for unknown addresses (when no catch-all mailbox is set).
INSERT OR IGNORE INTO mailboxes (id, address, display_name, type, color, is_active, is_system, created_at, updated_at)
VALUES ('system-unrouted', 'unrouted@system.invalid', 'Unrouted', 'shared', '#64748b', 1, 1,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- The traffic view lists every message by date across all mailboxes.
CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_direction_date ON messages(direction, date DESC);
