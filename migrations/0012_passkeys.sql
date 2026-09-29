-- Passkeys (WebAuthn): sign in with Face ID / Touch ID / fingerprint / a security key.
-- A passkey is bound to the host it was created on (rp_id), e.g. mail.example.org.
CREATE TABLE passkeys (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id  TEXT NOT NULL UNIQUE,  -- base64url, as the browser reports it
  public_key     TEXT NOT NULL,         -- base64url COSE public key
  counter        INTEGER NOT NULL DEFAULT 0,
  transports     TEXT,                  -- JSON array (usb, nfc, internal, hybrid…)
  rp_id          TEXT NOT NULL,
  name           TEXT NOT NULL,
  backed_up      INTEGER NOT NULL DEFAULT 0, -- synced passkey (iCloud Keychain, Google Password Manager…)
  created_at     TEXT NOT NULL,
  last_used_at   TEXT
);
CREATE INDEX idx_passkeys_user ON passkeys(user_id);

-- Single-use ceremony challenges (5 minutes). The id is the SHA-256 of a random
-- token kept in an HttpOnly cookie, so a challenge is tied to the browser that asked for it.
CREATE TABLE webauthn_challenges (
  id          TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('register', 'login')),
  challenge   TEXT NOT NULL,
  rp_id       TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX idx_webauthn_challenges_expiry ON webauthn_challenges(expires_at);
