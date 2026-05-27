-- Migration 021: Two-factor authentication (TOTP)
--
-- Adds the schema needed to support TOTP-based 2FA. Login-flow gating
-- ships in a follow-up migration; this one only persists the secrets
-- and recovery codes so the /api/auth/2fa/* endpoints can land first.
--
--   - users.totp_secret_enc          — AES-256-GCM encrypted TOTP secret.
--                                      Set by /2fa/setup, cleared by
--                                      /2fa/disable. NULL = no 2FA.
--   - users.totp_enabled_at          — non-null once the user has
--                                      confirmed setup by submitting a
--                                      valid TOTP code. Login flow
--                                      requires a 2FA code only when
--                                      this is non-null.
--   - user_recovery_codes            — 10 single-use recovery codes per
--                                      user, hashed at rest. Issued
--                                      once at /2fa/confirm time and
--                                      shown to the user once.

ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret_enc TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_users_totp_enabled ON users(totp_enabled_at) WHERE totp_enabled_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_recovery_codes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_recovery_codes_hash ON user_recovery_codes(code_hash);
CREATE INDEX IF NOT EXISTS idx_user_recovery_codes_user ON user_recovery_codes(user_id) WHERE used_at IS NULL;
