-- Migration 005: Automation Execution Module
-- Adds readiness validation persistence and bulk execution item tracking

-- 1. Readiness Validations: persisted preflight check results
CREATE TABLE IF NOT EXISTS readiness_validations (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  automation_asset_id INTEGER NOT NULL REFERENCES automation_assets(id) ON DELETE CASCADE,
  target_app_config_id INTEGER REFERENCES target_app_configs(id) ON DELETE SET NULL,
  validation_status TEXT NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('pending', 'passed', 'failed', 'partial')),
  target_url_reachable BOOLEAN,
  auth_config_present BOOLEAN,
  auth_success BOOLEAN,
  target_page_reachable BOOLEAN,
  selectors_valid BOOLEAN,
  scenario_approved BOOLEAN,
  test_files_present BOOLEAN,
  failure_reasons JSONB DEFAULT '[]',
  checks JSONB DEFAULT '[]',
  config_snapshot JSONB DEFAULT '{}',
  verified_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_readiness_validations_asset ON readiness_validations(automation_asset_id);
CREATE INDEX IF NOT EXISTS idx_readiness_validations_status ON readiness_validations(validation_status);

-- 2. Add readiness_validation_id to playwright_runs
ALTER TABLE playwright_runs ADD COLUMN IF NOT EXISTS readiness_validation_id INTEGER REFERENCES readiness_validations(id) ON DELETE SET NULL;

-- 3. Execution Run Items: per-script results within a bulk run
CREATE TABLE IF NOT EXISTS execution_run_items (
  id SERIAL PRIMARY KEY,
  execution_run_id INTEGER NOT NULL REFERENCES playwright_runs(id) ON DELETE CASCADE,
  automation_asset_id INTEGER NOT NULL REFERENCES automation_assets(id) ON DELETE CASCADE,
  scenario_id UUID,
  item_status TEXT NOT NULL DEFAULT 'queued' CHECK (item_status IN ('queued', 'running', 'passed', 'failed', 'blocked', 'skipped')),
  failure_reason TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  artifact_url TEXT,
  output_log TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_execution_run_items_run ON execution_run_items(execution_run_id);
CREATE INDEX IF NOT EXISTS idx_execution_run_items_asset ON execution_run_items(automation_asset_id);
CREATE INDEX IF NOT EXISTS idx_execution_run_items_status ON execution_run_items(item_status);
