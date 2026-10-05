-- Provider credentials entered in the app instead of as Worker secrets (the Resend API
-- key, the webhook signing secret). Values are sealed with worker/lib/secret-box.ts, so a
-- database export alone doesn't reveal them. Environment variables still win when set.
CREATE TABLE secrets (
  name        TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT
);

-- First-run setup progress lives in settings under key 'setup' (JSON, see worker/lib/setup.ts).
