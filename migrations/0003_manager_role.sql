-- Read-only "manager" role.
--
-- Stored as a flag instead of a new value in users.role: SQLite can only change
-- that column's CHECK constraint by rebuilding the table, and a rebuild cascades
-- deletes into sessions, memberships, templates and tokens. Adding a column is
-- safe and touches no existing rows.
--
-- Effective role = 'manager' when role = 'member' AND is_manager = 1 (see worker/lib/roles.ts).
ALTER TABLE users ADD COLUMN is_manager INTEGER NOT NULL DEFAULT 0;
