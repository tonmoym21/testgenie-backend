-- Migration 012: Runner columns for the persistent Playwright execution path
-- Run: node run-migration-012.js <DATABASE_URL>
--
-- Adds columns required for:
--   - Phase 0: persisting the run directory so traces/videos/screenshots survive
--   - Phase 1+: queue lineage (worker_id, queued_at) and retry-on-flake lineage
--     (retry_of_id) so the closed-loop story preserves history instead of
--     overwriting the original failure.
-- Also tightens the existing execution_run_items.scenario_id (currently typed
-- as UUID with no FK) so failures stay linkable to the scenario that birthed them.

-- 1. playwright_runs: queue + worker + artifact lineage
ALTER TABLE playwright_runs ADD COLUMN IF NOT EXISTS worker_id TEXT;
ALTER TABLE playwright_runs ADD COLUMN IF NOT EXISTS queued_at TIMESTAMPTZ;
ALTER TABLE playwright_runs ADD COLUMN IF NOT EXISTS retry_of_id INTEGER REFERENCES playwright_runs(id) ON DELETE SET NULL;
ALTER TABLE playwright_runs ADD COLUMN IF NOT EXISTS artifact_dir TEXT;

CREATE INDEX IF NOT EXISTS idx_playwright_runs_retry_of ON playwright_runs(retry_of_id);
CREATE INDEX IF NOT EXISTS idx_playwright_runs_queued_at ON playwright_runs(queued_at);

-- 2. execution_run_items.scenario_id -> scenarios(id) with ON DELETE SET NULL.
-- NOT VALID so existing rows (which may contain orphan UUIDs from earlier
-- experiments) don't block the migration; new inserts are still enforced.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'execution_run_items'
      AND constraint_name = 'execution_run_items_scenario_id_fkey'
  ) THEN
    ALTER TABLE execution_run_items
      ADD CONSTRAINT execution_run_items_scenario_id_fkey
      FOREIGN KEY (scenario_id) REFERENCES scenarios(id) ON DELETE SET NULL
      NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_execution_run_items_scenario ON execution_run_items(scenario_id);
