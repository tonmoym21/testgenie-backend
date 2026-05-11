-- Migration 015: Verify-after-apply lifecycle.
-- Run: node run-migration-015.js <DATABASE_URL>
--
-- Phase 4b left fix_attempts in 'proposed' (local apply) or 'pr_opened'
-- (push + PR) with no signal as to whether the patched spec actually
-- passes when re-run. That's the demo killer the council flagged: the
-- customer's first instinct on the PR is "is this nonsense?", and a
-- platform that can't answer THAT loses the room.
--
-- This migration adds:
--   - fix_attempts.verified_at        TIMESTAMPTZ
--   - 'verified' and 'verify_failed' to the status CHECK
-- so a downstream verify step can record the outcome of re-running the
-- patched test against the agent's branch.

ALTER TABLE fix_attempts ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

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
  CHECK (status IN (
    'queued', 'patching', 'proposed', 'pr_opened',
    'verified', 'verify_failed',
    'merged', 'failed', 'abandoned'
  ));
