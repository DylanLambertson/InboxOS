-- Rich user profiles: a photo and the details teammates look for in the directory.
-- job_title and phone already exist (0018). Every column has a default so existing
-- rows and older code keep working.
ALTER TABLE users ADD COLUMN avatar_key TEXT;                    -- R2 key under avatars/<userId>/, NULL = initials
ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN pronouns TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN department TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN location TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN timezone TEXT NOT NULL DEFAULT '';  -- IANA name, e.g. Europe/Berlin
ALTER TABLE users ADD COLUMN website TEXT NOT NULL DEFAULT '';   -- https:// only

-- The team directory lists active people by name.
CREATE INDEX IF NOT EXISTS idx_users_status_name ON users (status, name COLLATE NOCASE);
