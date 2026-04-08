-- Migration: Add playwright_tests table
-- Run: psql $DATABASE_URL -f 002_playwright_tests.sql

CREATE TABLE IF NOT EXISTS playwright_tests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scenario_id UUID NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  test_name TEXT NOT NULL,
  file_name TEXT NOT NULL,
  code TEXT NOT NULL,
  categories TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'generated',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_playwright_tests_project ON playwright_tests(project_id);
CREATE INDEX IF NOT EXISTS idx_playwright_tests_scenario ON playwright_tests(scenario_id);
CREATE INDEX IF NOT EXISTS idx_playwright_tests_story ON playwright_tests(story_id);
CREATE INDEX IF NOT EXISTS idx_playwright_tests_status ON playwright_tests(status);
