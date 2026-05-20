-- Migration 013: Closed-loop lineage (Story <-> Spec <-> Run <-> Failure <-> Fix)
-- Run: node run-migration-013.js <DATABASE_URL>
--
-- Today the chain stops at playwright_runs: we know how many specs passed/failed
-- but not which one failed with what error, whether that same failure has been
-- seen before, or what the agent did about it. This migration adds the three
-- joining tables that make the lineage queryable end-to-end.
--
-- Tables:
--   - playwright_run_results: one row per spec per run (per-test, not per-run)
--   - test_failures: deduplicated failure signatures (same error grouped across runs)
--   - fix_attempts: agent-authored fix PRs (empty until Phase 4 lands)

-- 1. Per-spec results -------------------------------------------------------
-- One row for every test the runner executed. Lets us answer "which specs
-- failed on run 42" without re-parsing raw_result_json, and "all runs of
-- spec 17" without a full scan.
CREATE TABLE IF NOT EXISTS playwright_run_results (
  id BIGSERIAL PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES playwright_runs(id) ON DELETE CASCADE,
  playwright_test_id INTEGER REFERENCES playwright_tests(id) ON DELETE SET NULL,
  scenario_id INTEGER REFERENCES scenarios(id) ON DELETE SET NULL,
  story_id INTEGER REFERENCES stories(id) ON DELETE SET NULL,
  -- File path + title together identify the test even if playwright_tests rows
  -- are renamed or deleted later. file_name is what Playwright's JSON report uses.
  file_name TEXT NOT NULL,
  test_title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'timedOut', 'skipped', 'interrupted')),
  duration_ms INTEGER,
  retry_attempt INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  error_stack TEXT,
  -- Stable hash of normalized error_message + top stack frame. Used to dedupe
  -- failures into test_failures. NULL for passing rows.
  failure_signature TEXT,
  -- Per-spec artifacts (relative to RUNS_BASE_DIR, same convention as run-level cols)
  trace_path TEXT,
  video_path TEXT,
  screenshot_paths JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pwr_results_run ON playwright_run_results(run_id);
CREATE INDEX IF NOT EXISTS idx_pwr_results_test ON playwright_run_results(playwright_test_id);
CREATE INDEX IF NOT EXISTS idx_pwr_results_story ON playwright_run_results(story_id);
CREATE INDEX IF NOT EXISTS idx_pwr_results_signature ON playwright_run_results(failure_signature)
  WHERE failure_signature IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pwr_results_status ON playwright_run_results(status);

-- 2. Deduplicated failures --------------------------------------------------
-- One row per distinct failure_signature per project. Updated on each new
-- occurrence (last_seen_at, occurrence_count, last_run_id). Powers
-- "this failure has happened N times across these stories".
CREATE TABLE IF NOT EXISTS test_failures (
  id BIGSERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  failure_signature TEXT NOT NULL,
  -- Sample error text (first occurrence) for the UI. Truncated at write time.
  sample_error_message TEXT,
  sample_error_stack TEXT,
  -- Most recent spec that hit this signature. Useful for "open the trace".
  last_test_id INTEGER REFERENCES playwright_tests(id) ON DELETE SET NULL,
  last_run_id INTEGER REFERENCES playwright_runs(id) ON DELETE SET NULL,
  last_story_id INTEGER REFERENCES stories(id) ON DELETE SET NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Lifecycle: 'open' = failing, 'fix_proposed' = agent opened PR,
  -- 'fix_merged' = PR merged, 'wont_fix' = manually closed, 'resolved' = passed since.
  fix_status TEXT NOT NULL DEFAULT 'open'
    CHECK (fix_status IN ('open', 'fix_proposed', 'fix_merged', 'wont_fix', 'resolved')),
  resolved_at TIMESTAMPTZ,
  UNIQUE (project_id, failure_signature)
);

CREATE INDEX IF NOT EXISTS idx_test_failures_project_status ON test_failures(project_id, fix_status);
CREATE INDEX IF NOT EXISTS idx_test_failures_last_seen ON test_failures(last_seen_at DESC);

-- 3. Fix attempts (Phase 4 writes; Phase 3 just provisions) -----------------
-- One row per attempt the agent makes against a test_failure. Multiple
-- attempts allowed so we can see retries with different models / strategies.
CREATE TABLE IF NOT EXISTS fix_attempts (
  id BIGSERIAL PRIMARY KEY,
  test_failure_id BIGINT NOT NULL REFERENCES test_failures(id) ON DELETE CASCADE,
  triggered_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- Which LLM produced the patch. Free-form so BYO-key shops (Ollama, etc.) work.
  model_provider TEXT,
  model_name TEXT,
  -- Branch and PR created by the agent. branch_name is local; pr_url is null
  -- until the GitHub step succeeds.
  branch_name TEXT,
  pr_url TEXT,
  pr_number INTEGER,
  -- 'queued' -> 'patching' -> 'pr_opened' -> 'merged' | 'failed' | 'abandoned'
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'patching', 'pr_opened', 'merged', 'failed', 'abandoned')),
  -- Captured prompt and diff for audit / fine-tuning later. Truncated at write.
  prompt_excerpt TEXT,
  patch_diff TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_fix_attempts_failure ON fix_attempts(test_failure_id);
CREATE INDEX IF NOT EXISTS idx_fix_attempts_status ON fix_attempts(status);
CREATE INDEX IF NOT EXISTS idx_fix_attempts_pr ON fix_attempts(pr_url) WHERE pr_url IS NOT NULL;
