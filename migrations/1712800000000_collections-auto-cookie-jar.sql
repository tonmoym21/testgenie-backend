-- Migration: Per-collection auto cookie jar toggle.
-- When ON, the collection runner maintains a tough-cookie jar for the run,
-- ingesting Set-Cookie from every response (incl. redirect hops) and
-- auto-attaching matching Cookie headers on subsequent requests.

ALTER TABLE collections
  ADD COLUMN IF NOT EXISTS auto_cookie_jar BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN collections.auto_cookie_jar IS
  'When true, the collection runner maintains a per-run cookie jar (tough-cookie) and forces serial execution.';
