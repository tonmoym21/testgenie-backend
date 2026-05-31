-- Persisted audit trail for autofix operator actions + state-machine
-- events. Until now every `logger.warn({event:'autofix.*', ...})`
-- call wrote to stdout only — useful for grepping a live tail but
-- invisible to the dashboard. For shared-team deployments
-- ("who clicked Reopen on failure 42 yesterday?") that's the missing
-- accountability layer.
--
-- This PR creates the substrate + wires ONE call site (the reopen
-- path) as a worked example. Subsequent PRs wire the remaining
-- ~7 sites one at a time so each one stays a small, focused change.
--
-- Schema choices:
--   event_type TEXT — the existing logger event names
--                     ('autofix.failure.reopened', etc.) used
--                     verbatim. Indexed for filtered reads.
--   project_id / failure_id / fix_attempt_id NULLABLE — different
--                     event types populate different subsets. Index
--                     per column so per-resource queries are cheap.
--   triggered_by NULLABLE — null for cron-originated events; set to
--                     users.id for operator actions.
--   payload JSONB — overflow bag for event-specific fields (attempts
--                   counter, status transitions, etc.) without
--                   having to migrate the table every time a new
--                   event type wants a new dimension. JSONB not
--                   JSON so we can index into it later if needed.
--   occurred_at TIMESTAMPTZ DEFAULT NOW() — set server-side so
--                   clock-skewed clients can't backdate events.
--
-- FK to projects + test_failures + fix_attempts uses ON DELETE SET
-- NULL rather than CASCADE. Cascading audit events when their
-- subject is deleted would defeat the point of an audit log — we
-- want the "who deleted what" trail to outlive the deleted thing.

CREATE TABLE IF NOT EXISTS autofix_audit_events (
  id              BIGSERIAL PRIMARY KEY,
  event_type      TEXT NOT NULL,
  project_id      INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  failure_id      BIGINT  REFERENCES test_failures(id) ON DELETE SET NULL,
  fix_attempt_id  BIGINT  REFERENCES fix_attempts(id) ON DELETE SET NULL,
  triggered_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Listing pattern is "newest first within a filter," typically by
-- project_id + event_type + occurred_at range. Composite indexes
-- give a single-scan path for the common queries:
--   - per-project, per-event_type, recent first
--   - per-failure history
--   - global recent-events stream (occurred_at alone)
CREATE INDEX IF NOT EXISTS idx_autofix_audit_project_occurred
  ON autofix_audit_events (project_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_autofix_audit_event_occurred
  ON autofix_audit_events (event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_autofix_audit_failure_occurred
  ON autofix_audit_events (failure_id, occurred_at DESC)
  WHERE failure_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_autofix_audit_occurred
  ON autofix_audit_events (occurred_at DESC);
