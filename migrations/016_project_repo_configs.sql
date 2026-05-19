-- Migration 016: Per-project repo configuration for the auto-fix pipeline.
-- Run: node run-migration-016.js <DATABASE_URL>
--
-- Up to this point, autoFixApplyService and autoFixVerifyService required
-- the CALLER to pass {repo, base, remote} on every invocation. That works
-- for one customer with one repo wired up by hand; it does not scale to
-- a SaaS-style deployment where multiple customers each have their own
-- checkout, default branch, and GitHub repo URL.
--
-- This table holds one config row per project. The services fall back
-- to it whenever the caller does not pass an explicit override — so the
-- existing CLI + scripts keep working, but a cron / API endpoint can
-- now do `applyFix({ fixAttemptId })` and have everything resolve.
--
-- Idempotent: rerunning is a no-op (IF NOT EXISTS guards).

CREATE TABLE IF NOT EXISTS project_repo_configs (
  id              SERIAL PRIMARY KEY,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repo_path       TEXT NOT NULL,
  base_branch     TEXT NOT NULL DEFAULT 'main',
  remote_name     TEXT NOT NULL DEFAULT 'origin',
  -- 'owner/name' form, used by the GitHub webhook to scope merge events
  -- to a project and by the apply step when shelling out to `gh`.
  github_repo     TEXT,
  -- Where Playwright specs live relative to repo_path. The verify step
  -- joins this with playwright_tests.file_name to build the path passed
  -- to `npx playwright test`.
  spec_dir        TEXT NOT NULL DEFAULT 'tests',
  organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT project_repo_configs_one_per_project UNIQUE(project_id)
);

CREATE INDEX IF NOT EXISTS idx_project_repo_configs_project ON project_repo_configs(project_id);
CREATE INDEX IF NOT EXISTS idx_project_repo_configs_github  ON project_repo_configs(github_repo);
CREATE INDEX IF NOT EXISTS idx_project_repo_configs_org     ON project_repo_configs(organization_id);
