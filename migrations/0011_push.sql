-- Web Push: one row per device (browser / installed app) that turned on notifications.
CREATE TABLE push_subscriptions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  user_agent  TEXT,
  failures    INTEGER NOT NULL DEFAULT 0,
  last_ok_at  TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_push_user ON push_subscriptions(user_id);
