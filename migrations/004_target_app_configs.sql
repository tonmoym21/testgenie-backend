-- Migration 004: Target Application Configs
-- Stores target app metadata required for grounded Playwright test generation & execution

CREATE TABLE IF NOT EXISTS target_app_configs (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Default',
  base_url TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'staging' CHECK (environment IN ('local', 'staging', 'production', 'test')),

  -- Auth
  auth_type TEXT NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none', 'form_login', 'token', 'cookie', 'storage_state', 'basic_auth')),
  login_url TEXT,
  auth_username_env TEXT,       -- env var name, e.g. 'TEST_USERNAME' (never store raw creds)
  auth_password_env TEXT,       -- env var name, e.g. 'TEST_PASSWORD'
  auth_token_env TEXT,          -- env var name for bearer token
  storage_state_path TEXT,      -- path to Playwright storageState JSON

  -- Selector strategy
  selector_strategy TEXT NOT NULL DEFAULT 'role_first' CHECK (selector_strategy IN ('role_first', 'testid_first', 'label_first', 'css_fallback')),
  selector_map JSONB DEFAULT '{}',    -- { "loginButton": "getByRole('button', { name: 'Sign in' })", ... }
  known_testids JSONB DEFAULT '[]',   -- ["submit", "email", ...] verified data-testid values

  -- Page inventory (optional, populated by DOM discovery)
  page_inventory JSONB DEFAULT '[]',  -- [{ "path": "/login", "title": "Login", "selectors": [...] }]

  -- Metadata
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_target_app_configs_project ON target_app_configs(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_target_app_configs_default ON target_app_configs(project_id) WHERE is_default = true;

-- Add target_app_config_id to automation_assets so each asset knows its target
ALTER TABLE automation_assets ADD COLUMN IF NOT EXISTS target_app_config_id INTEGER REFERENCES target_app_configs(id) ON DELETE SET NULL;

-- Add execution_readiness to automation_assets
ALTER TABLE automation_assets ADD COLUMN IF NOT EXISTS execution_readiness TEXT NOT NULL DEFAULT 'draft'
  CHECK (execution_readiness IN ('draft', 'needs_selector_mapping', 'ready', 'validated'));

-- Add preflight_result to playwright_runs
ALTER TABLE playwright_runs ADD COLUMN IF NOT EXISTS preflight_result JSONB;

-- Trigger
DROP TRIGGER IF EXISTS trg_target_app_configs_updated_at ON target_app_configs;
CREATE TRIGGER trg_target_app_configs_updated_at
  BEFORE UPDATE ON target_app_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
