-- Migration 008: Dashboard Dependencies
-- Creates collections, environments, scheduled_tests tables required by dashboard
-- Run: node run-migration-008.js <DATABASE_URL>

-- ============================================================================
-- 1. Environments table (base table for environment variables)
-- ============================================================================
CREATE TABLE IF NOT EXISTS environments (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    variables JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT false,
    is_secret JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_environments_user_id ON environments(user_id);
CREATE INDEX IF NOT EXISTS idx_environments_active ON environments(user_id, is_active);

-- ============================================================================
-- 2. Collections table (test collections/suites)
-- ============================================================================
CREATE TABLE IF NOT EXISTS collections (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_collections_user_id ON collections(user_id);

-- ============================================================================
-- 3. Collection tests (tests within collections)
-- ============================================================================
CREATE TABLE IF NOT EXISTS collection_tests (
    id SERIAL PRIMARY KEY,
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    test_type TEXT NOT NULL CHECK (test_type IN ('ui', 'api')),
    test_definition JSONB NOT NULL,
    sort_order INTEGER DEFAULT 0,
    folder_id INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_collection_tests_collection ON collection_tests(collection_id);

-- ============================================================================
-- 4. Scheduled tests table
-- ============================================================================
CREATE TABLE IF NOT EXISTS scheduled_tests (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT,
    test_definition JSONB,
    cron_expression TEXT NOT NULL,
    is_active BOOLEAN DEFAULT true,
    schedule_type TEXT DEFAULT 'single',
    collection_id INTEGER REFERENCES collections(id) ON DELETE CASCADE,
    folder_id INTEGER,
    environment_id INTEGER REFERENCES environments(id) ON DELETE SET NULL,
    test_ids JSONB,
    notify_on_failure BOOLEAN DEFAULT true,
    notify_email TEXT,
    run_count INTEGER DEFAULT 0,
    last_run_at TIMESTAMPTZ,
    last_status TEXT,
    last_result TEXT,
    next_run_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_tests_user_id ON scheduled_tests(user_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_tests_active ON scheduled_tests(is_active);
CREATE INDEX IF NOT EXISTS idx_scheduled_tests_collection ON scheduled_tests(collection_id);

-- ============================================================================
-- 5. Collection folders table
-- ============================================================================
CREATE TABLE IF NOT EXISTS collection_folders (
    id SERIAL PRIMARY KEY,
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    parent_folder_id INTEGER REFERENCES collection_folders(id) ON DELETE CASCADE,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_collection_folders_collection ON collection_folders(collection_id);
CREATE INDEX IF NOT EXISTS idx_collection_folders_parent ON collection_folders(parent_folder_id);

-- Add folder_id FK to collection_tests if column exists but FK doesn't
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'collection_tests_folder_id_fkey'
    ) THEN
        BEGIN
            ALTER TABLE collection_tests 
            ADD CONSTRAINT collection_tests_folder_id_fkey 
            FOREIGN KEY (folder_id) REFERENCES collection_folders(id) ON DELETE SET NULL;
        EXCEPTION WHEN others THEN
            NULL;
        END;
    END IF;
END $$;

-- ============================================================================
-- 6. Run reports table (execution history with full details)
-- ============================================================================
CREATE TABLE IF NOT EXISTS run_reports (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    run_type TEXT NOT NULL,
    collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL,
    folder_id INTEGER REFERENCES collection_folders(id) ON DELETE SET NULL,
    schedule_id INTEGER REFERENCES scheduled_tests(id) ON DELETE SET NULL,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    environment_id INTEGER REFERENCES environments(id) ON DELETE SET NULL,
    environment_name TEXT,
    environment_snapshot JSONB,
    total_tests INTEGER NOT NULL DEFAULT 0,
    passed_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    total_duration_ms INTEGER NOT NULL DEFAULT 0,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'running',
    test_results JSONB DEFAULT '[]',
    triggered_by TEXT DEFAULT 'manual',
    title TEXT,
    tags JSONB DEFAULT '[]',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_run_reports_user ON run_reports(user_id);
CREATE INDEX IF NOT EXISTS idx_run_reports_status ON run_reports(status);
CREATE INDEX IF NOT EXISTS idx_run_reports_created ON run_reports(created_at DESC);

-- ============================================================================
-- 7. Triggers for updated_at
-- ============================================================================
DO $$
BEGIN
    DROP TRIGGER IF EXISTS trg_environments_updated_at ON environments;
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at') THEN
        CREATE TRIGGER trg_environments_updated_at
            BEFORE UPDATE ON environments
            FOR EACH ROW EXECUTE FUNCTION update_updated_at();
    END IF;

    DROP TRIGGER IF EXISTS trg_collections_updated_at ON collections;
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at') THEN
        CREATE TRIGGER trg_collections_updated_at
            BEFORE UPDATE ON collections
            FOR EACH ROW EXECUTE FUNCTION update_updated_at();
    END IF;

    DROP TRIGGER IF EXISTS trg_scheduled_tests_updated_at ON scheduled_tests;
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at') THEN
        CREATE TRIGGER trg_scheduled_tests_updated_at
            BEFORE UPDATE ON scheduled_tests
            FOR EACH ROW EXECUTE FUNCTION update_updated_at();
    END IF;

    DROP TRIGGER IF EXISTS trg_collection_folders_updated_at ON collection_folders;
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at') THEN
        CREATE TRIGGER trg_collection_folders_updated_at
            BEFORE UPDATE ON collection_folders
            FOR EACH ROW EXECUTE FUNCTION update_updated_at();
    END IF;
END $$;
