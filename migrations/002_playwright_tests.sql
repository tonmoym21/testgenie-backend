DROP TABLE IF EXISTS playwright_tests;

CREATE TABLE playwright_tests (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL,
  scenario_id INTEGER NOT NULL,
  story_id INTEGER NOT NULL,
  test_name TEXT NOT NULL,
  file_name TEXT NOT NULL,
  code TEXT NOT NULL,
  categories TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'generated',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);