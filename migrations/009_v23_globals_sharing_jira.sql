-- v2.3: Global variables, collection sharing, Jira integration

-- Workspace-scoped global variables (visible to whole team via SSE sync)
CREATE TABLE IF NOT EXISTS global_variables (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key VARCHAR(255) NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  is_secret BOOLEAN NOT NULL DEFAULT false,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_global_vars_user ON global_variables(user_id);
CREATE INDEX IF NOT EXISTS idx_global_vars_key ON global_variables(user_id, key);

-- Collection sharing: workspace permissions (view / run / fork)
CREATE TABLE IF NOT EXISTS collection_shares (
  id SERIAL PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shared_with_email VARCHAR(255),
  permission VARCHAR(10) NOT NULL DEFAULT 'view' CHECK (permission IN ('view', 'run', 'fork')),
  share_token VARCHAR(64) UNIQUE,
  is_public BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_col_shares_collection ON collection_shares(collection_id);
CREATE INDEX IF NOT EXISTS idx_col_shares_token ON collection_shares(share_token);

-- Jira OAuth2 connections per user
CREATE TABLE IF NOT EXISTS jira_integrations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  jira_base_url VARCHAR(500) NOT NULL,
  cloud_id VARCHAR(255),
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id)
);

-- Jira ticket ↔ test/collection links
CREATE TABLE IF NOT EXISTS jira_test_links (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  jira_issue_key VARCHAR(50) NOT NULL,
  jira_issue_id VARCHAR(50),
  jira_issue_summary TEXT,
  collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL,
  collection_test_id INTEGER REFERENCES collection_tests(id) ON DELETE SET NULL,
  sync_results BOOLEAN NOT NULL DEFAULT true,
  last_synced_at TIMESTAMPTZ,
  last_run_status VARCHAR(20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jira_links_user ON jira_test_links(user_id);
CREATE INDEX IF NOT EXISTS idx_jira_links_issue ON jira_test_links(jira_issue_key);
CREATE INDEX IF NOT EXISTS idx_jira_links_collection ON jira_test_links(collection_id);

-- Track parallel run progress per run_report
ALTER TABLE run_reports ADD COLUMN IF NOT EXISTS progress_completed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE run_reports ADD COLUMN IF NOT EXISTS progress_total INTEGER NOT NULL DEFAULT 0;
