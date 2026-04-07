-- Migration: Story-to-CSV foundation tables
-- Run: psql $DATABASE_URL -f migrations/001_stories_and_scenarios.sql

CREATE TABLE IF NOT EXISTS stories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'text' CHECK (source_type IN ('text', 'url')),
  source_url TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'extracted', 'reviewed', 'exported')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scenarios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN (
    'happy_path', 'negative', 'edge', 'validation',
    'role_permission', 'state_transition', 'api_impact', 'non_functional'
  )),
  title TEXT NOT NULL,
  summary TEXT,
  preconditions JSONB DEFAULT '[]'::jsonb,
  test_intent TEXT,
  inputs JSONB DEFAULT '{}'::jsonb,
  expected_outcome TEXT,
  priority TEXT NOT NULL DEFAULT 'P1' CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stories_project_user ON stories(project_id, user_id);
CREATE INDEX IF NOT EXISTS idx_stories_project ON stories(project_id);
CREATE INDEX IF NOT EXISTS idx_scenarios_story ON scenarios(story_id);
CREATE INDEX IF NOT EXISTS idx_scenarios_story_status ON scenarios(story_id, status);
CREATE INDEX IF NOT EXISTS idx_scenarios_project ON scenarios(project_id);
