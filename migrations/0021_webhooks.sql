-- Outbound webhooks (Admin → Webhooks): endpoints that receive signed event
-- notifications, and a log of every delivery attempt for debugging and retries.
-- Replaces the single NOTIFY_WEBHOOK_URL / NOTIFY_WEBHOOK_SECRET environment hook.
CREATE TABLE webhook_endpoints (
  id               TEXT PRIMARY KEY,
  url              TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  events           TEXT NOT NULL DEFAULT '[]',      -- JSON array of event types
  secret           TEXT NOT NULL,                   -- whsec_… sealed with the secret box
  enabled          INTEGER NOT NULL DEFAULT 1,
  disabled_reason  TEXT,                            -- set when switched off automatically
  created_by       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  last_success_at  TEXT,
  last_failure_at  TEXT,
  failure_streak   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE webhook_deliveries (
  id                TEXT PRIMARY KEY,
  endpoint_id       TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_type        TEXT NOT NULL,
  event_id          TEXT NOT NULL,                  -- the webhook-id header; the same across retries
  payload           TEXT NOT NULL,                  -- the exact JSON body that is signed and sent
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   TEXT,
  response_status   INTEGER,
  response_ms       INTEGER,
  response_excerpt  TEXT,
  error             TEXT,
  created_at        TEXT NOT NULL,
  delivered_at      TEXT
);
CREATE INDEX idx_webhook_deliveries_due ON webhook_deliveries(next_attempt_at) WHERE status = 'pending';
CREATE INDEX idx_webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id, created_at DESC);
CREATE INDEX idx_webhook_deliveries_created ON webhook_deliveries(created_at);

-- Admin → Users: a person's recent audit events in their detail panel.
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs(target_type, target_id, created_at DESC);
