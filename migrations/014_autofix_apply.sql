-- Migration 014: Apply-step columns + new lifecycle state for fix_attempts.
-- Run: node run-migration-014.js <DATABASE_URL>
--
-- Phase 4a stored the patch but had no way to actually open a PR — and used
-- status='pr_opened' optimistically even when no PR existed. This migration:
--   - Adds new_code so the apply step can write the full file to disk without
--     re-running the LLM or applying the diff blind.
--   - Adds applied_at so we can tell when the local commit landed.
--   - Adds 'proposed' to the status CHECK so we can distinguish "patch is ready"
--     from "PR was actually opened".

ALTER TABLE fix_attempts ADD COLUMN IF NOT EXISTS new_code TEXT;
ALTER TABLE fix_attempts ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ;

-- Postgres CHECK constraints can't be edited in place — drop and recreate.
-- The constraint name is auto-generated; query for it to stay schema-tolerant.
DO $$
DECLARE
  cname TEXT;
BEGIN
  SELECT conname INTO cname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'fix_attempts'
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) ILIKE '%status%';

  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE fix_attempts DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE fix_attempts
  ADD CONSTRAINT fix_attempts_status_check
  CHECK (status IN ('queued', 'patching', 'proposed', 'pr_opened', 'merged', 'failed', 'abandoned'));
