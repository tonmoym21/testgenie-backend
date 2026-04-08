-- Migration: Automation Assets & Playwright Execution Runs
-- Run: node run-migration-003.js <DATABASE_URL>

-- Ensure the updated_at trigger function exists
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Automation Assets: persisted generated Playwright test suites
CREATE TABLE IF NOT EXISTS automation_assets (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  story_id UUID,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  categories TEXT[] NOT NULL DEFAULT '{}',
  tags TEXT[] NOT NULL DEFAULT '{}',
  generation_type TEXT NOT NULL DEFAULT 'single' CHECK (generation_type IN ('single', 'bulk', 'full_project')),
  framework TEXT NOT NULL DEFAULT 'playwright',
  language TEXT NOT NULL DEFAULT 'typescript',
  source_test_ids JSONB DEFAULT '[]',
  generated_files_manifest JSONB DEFAULT '[]',
  config_code TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'archived')),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_run_at TIMESTAMPTZ,
  last_run_status TEXT CHECK (last_run_status IN ('passed', 'failed', 'running', 'queued', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_automation_assets_project ON automation_assets(project_id);
CREATE INDEX IF NOT EXISTS idx_automation_assets_status ON automation_assets(status);
CREATE INDEX IF NOT EXISTS idx_automation_assets_created ON automation_assets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_assets_slug ON automation_assets(project_id, slug);
CREATE INDEX IF NOT EXISTS idx_automation_assets_categories ON automation_assets USING GIN(categories);

-- Playwright Execution Runs
CREATE TABLE IF NOT EXISTS playwright_runs (
  id SERIAL PRIMARY KEY,
  automation_asset_id INTEGER NOT NULL REFERENCES automation_assets(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  triggered_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_type TEXT NOT NULL DEFAULT 'single' CHECK (run_type IN ('single', 'bulk', 'category', 'project')),
  category_filter TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'passed', 'failed', 'cancelled')),
  browser TEXT NOT NULL DEFAULT 'chromium',
  base_url TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  total_tests INTEGER DEFAULT 0,
  passed_tests INTEGER DEFAULT 0,
  failed_tests INTEGER DEFAULT 0,
  skipped_tests INTEGER DEFAULT 0,
  output_logs TEXT,
  error_summary TEXT,
  html_report_url TEXT,
  trace_url TEXT,
  screenshot_urls JSONB DEFAULT '[]',
  video_urls JSONB DEFAULT '[]',
  raw_result_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_playwright_runs_asset ON playwright_runs(automation_asset_id);
CREATE INDEX IF NOT EXISTS idx_playwright_runs_project ON playwright_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_playwright_runs_status ON playwright_runs(status);
CREATE INDEX IF NOT EXISTS idx_playwright_runs_created ON playwright_runs(created_at DESC);

-- Update trigger
DROP TRIGGER IF EXISTS trg_automation_assets_updated_at ON automation_assets;
CREATE TRIGGER trg_automation_assets_updated_at
  BEFORE UPDATE ON automation_assets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
