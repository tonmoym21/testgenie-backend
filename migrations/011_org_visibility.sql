-- Migration 011: Organization-wide visibility for projects, collections, environments, scheduled_tests
-- Adds organization_id column + backfill from creator's org so members of the same
-- organization can see and run each other's resources.

-- 1. projects
ALTER TABLE projects ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(organization_id);

UPDATE projects p
SET organization_id = u.organization_id
FROM users u
WHERE p.user_id = u.id
  AND u.organization_id IS NOT NULL
  AND p.organization_id IS NULL;

-- 2. collections
ALTER TABLE collections ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_collections_org ON collections(organization_id);

UPDATE collections c
SET organization_id = u.organization_id
FROM users u
WHERE c.user_id = u.id
  AND u.organization_id IS NOT NULL
  AND c.organization_id IS NULL;

-- 3. environments
ALTER TABLE environments ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_environments_org ON environments(organization_id);

UPDATE environments e
SET organization_id = u.organization_id
FROM users u
WHERE e.user_id = u.id
  AND u.organization_id IS NOT NULL
  AND e.organization_id IS NULL;

-- 4. scheduled_tests
ALTER TABLE scheduled_tests ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_scheduled_tests_org ON scheduled_tests(organization_id);

UPDATE scheduled_tests s
SET organization_id = u.organization_id
FROM users u
WHERE s.user_id = u.id
  AND u.organization_id IS NOT NULL
  AND s.organization_id IS NULL;

-- 5. run_reports — also denormalize so org-mates see each other's run history
ALTER TABLE run_reports ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_run_reports_org ON run_reports(organization_id);

UPDATE run_reports r
SET organization_id = u.organization_id
FROM users u
WHERE r.user_id = u.id
  AND u.organization_id IS NOT NULL
  AND r.organization_id IS NULL;
