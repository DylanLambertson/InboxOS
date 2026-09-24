-- SCIM 2.0 provisioning: Okta, Microsoft Entra ID and Google create, update and deactivate
-- accounts. The IdP's own id for a user is kept so its later lookups by externalId work.
ALTER TABLE users ADD COLUMN scim_external_id TEXT;
CREATE INDEX idx_users_scim_external ON users(scim_external_id) WHERE scim_external_id IS NOT NULL;

-- One active bearer token at a time (rotating revokes the old one). Separate from api_keys:
-- it can manage accounts, which no API key can.
CREATE TABLE scim_tokens (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,   -- SHA-256 of the token; the token itself is shown once
  prefix        TEXT NOT NULL,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  last_used_at  TEXT,
  revoked_at    TEXT,
  created_at    TEXT NOT NULL
);
