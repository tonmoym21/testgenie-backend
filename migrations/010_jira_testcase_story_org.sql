-- Migration 010: Jira test-case linking, story-linked manual test cases, org-wide visibility

-- 1. Link test_cases to a story (for manual test cases written inside a story context)
ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS story_id INTEGER REFERENCES stories(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_test_cases_story_id ON test_cases(story_id);

-- 2. Store the Jira issue key on a test_case when linked
ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS jira_issue_key VARCHAR(50);
CREATE INDEX IF NOT EXISTS idx_test_cases_jira_key ON test_cases(jira_issue_key);

-- 3. Denormalize organization_id onto test_cases for efficient org-wide queries
ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_test_cases_org ON test_cases(organization_id);

-- 4. Store the Jira issue key on scenarios when linked
ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS jira_issue_key VARCHAR(50);
CREATE INDEX IF NOT EXISTS idx_scenarios_jira_key ON scenarios(jira_issue_key);

-- 5. Backfill organization_id for existing test_cases from their creator's org
UPDATE test_cases tc
SET organization_id = u.organization_id
FROM users u
WHERE tc.user_id = u.id
  AND u.organization_id IS NOT NULL
  AND tc.organization_id IS NULL;
