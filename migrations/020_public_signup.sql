-- Migration 020: Public multi-tenant signup
-- Adds the schema needed to open registration to new companies safely.
--
--   - users.email_verified_at              — null until the user clicks the
--                                            verification link. Existing rows
--                                            are grandfathered to created_at.
--   - organizations.created_via            — 'first_user' | 'signup' | 'invite'
--                                            | 'admin'. Audit + analytics.
--   - organizations.verified_at            — null while the org is "pending"
--                                            (awaiting the owner's email
--                                            verification). Only verified orgs
--                                            claim their domain.
--   - email_verification_tokens            — single-use, 24h-TTL tokens for
--                                            signup verification + future
--                                            email-change flows. Token stored
--                                            HASHED (sha256), never plaintext.
--   - Unique partial index on
--     organizations.domain WHERE
--     verified_at IS NOT NULL              — race-safe domain claim. Pending
--                                            orgs don't compete. First org to
--                                            verify locks the domain.

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
-- Grandfather every existing user. Anyone already in the system pre-signup-flow
-- is trusted (they got in via the old register() or by invite).
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_email_verified ON users(email_verified_at) WHERE email_verified_at IS NULL;

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS created_via TEXT NOT NULL DEFAULT 'admin'
  CHECK (created_via IN ('first_user', 'signup', 'invite', 'admin'));
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
-- Existing orgs are verified by definition — they were created before this
-- gating existed. Stamp verified_at = created_at so they keep their domain.
UPDATE organizations SET verified_at = created_at WHERE verified_at IS NULL;
-- Best-effort backfill for created_via on existing rows: org #1 was the
-- first-user bootstrap; everything else came from invites. The 'admin'
-- default covers anything we can't classify.
UPDATE organizations SET created_via = 'first_user' WHERE id = 1 AND created_via = 'admin';

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'signup'
    CHECK (purpose IN ('signup', 'email_change')),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_verif_token_hash ON email_verification_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_email_verif_user ON email_verification_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_email_verif_expires ON email_verification_tokens(expires_at) WHERE used_at IS NULL;

-- Race-safe domain claim. Two simultaneous signups for @acme.com both create
-- pending orgs (verified_at NULL, both excluded from this index). When the
-- first one verifies, this unique index lets exactly one INSERT/UPDATE win;
-- the loser's verify endpoint catches the constraint violation and returns
-- "domain already claimed, request an invite". Partial index keeps NULL
-- domains (org-less or legacy) from colliding.
CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_verified_domain
  ON organizations(LOWER(domain))
  WHERE verified_at IS NOT NULL AND domain IS NOT NULL AND domain <> '';
