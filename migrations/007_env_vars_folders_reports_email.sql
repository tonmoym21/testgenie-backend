-- Migration 007: Environment variables with secrets, collection folders, run reports, email queue
-- Up Migration

-- ============================================================================
-- 1. Enhanced environments with secrets support
-- ============================================================================
ALTER TABLE environments 
ADD COLUMN IF NOT EXISTS is_secret JSONB DEFAULT '{}';

-- ============================================================================
-- 2. Collection folders for organization
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

-- Add folder_id to collection_tests
ALTER TABLE collection_tests
ADD COLUMN IF NOT EXISTS folder_id INTEGER REFERENCES collection_folders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_collection_tests_folder ON collection_tests(folder_id);

-- ============================================================================
-- 3. Enhanced scheduled_tests for collection/folder support
-- ============================================================================
ALTER TABLE scheduled_tests
ADD COLUMN IF NOT EXISTS name TEXT,
ADD COLUMN IF NOT EXISTS collection_id INTEGER REFERENCES collections(id) ON DELETE CASCADE,
ADD COLUMN IF NOT EXISTS folder_id INTEGER REFERENCES collection_folders(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS environment_id INTEGER REFERENCES environments(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS schedule_type TEXT DEFAULT 'single',
ADD COLUMN IF NOT EXISTS test_ids JSONB,
ADD COLUMN IF NOT EXISTS notify_on_failure BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS notify_email TEXT,
ADD COLUMN IF NOT EXISTS run_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_run_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS last_status TEXT,
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_scheduled_tests_collection ON scheduled_tests(collection_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_tests_folder ON scheduled_tests(folder_id);

-- ============================================================================
-- 4. Run reports table for detailed execution reports
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
CREATE INDEX IF NOT EXISTS idx_run_reports_run_type ON run_reports(run_type);
CREATE INDEX IF NOT EXISTS idx_run_reports_status ON run_reports(status);
CREATE INDEX IF NOT EXISTS idx_run_reports_created ON run_reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_reports_collection ON run_reports(collection_id);
CREATE INDEX IF NOT EXISTS idx_run_reports_project ON run_reports(project_id);

-- ============================================================================
-- 5. Email queue for report delivery
-- ============================================================================
CREATE TABLE IF NOT EXISTS email_queue (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    body_html TEXT NOT NULL,
    body_text TEXT,
    report_id INTEGER REFERENCES run_reports(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3,
    last_error TEXT,
    scheduled_at TIMESTAMPTZ DEFAULT NOW(),
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_queue_status ON email_queue(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_email_queue_user ON email_queue(user_id);
CREATE INDEX IF NOT EXISTS idx_email_queue_report ON email_queue(report_id);

-- ============================================================================
-- 6. Dashboard metrics cache table for performance
-- ============================================================================
CREATE TABLE IF NOT EXISTS dashboard_metrics_cache (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    metric_type TEXT NOT NULL,
    metrics_data JSONB NOT NULL,
    computed_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '5 minutes',
    UNIQUE(user_id, metric_type)
);

CREATE INDEX IF NOT EXISTS idx_dashboard_metrics_user ON dashboard_metrics_cache(user_id);

-- ============================================================================
-- 7. Add raw_response column to test_executions if not exists
-- ============================================================================
ALTER TABLE test_executions
ADD COLUMN IF NOT EXISTS raw_response JSONB;

-- ============================================================================
-- Triggers for updated_at (only if function exists)
-- ============================================================================
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at') THEN
        DROP TRIGGER IF EXISTS trg_collection_folders_updated_at ON collection_folders;
        CREATE TRIGGER trg_collection_folders_updated_at
            BEFORE UPDATE ON collection_folders
            FOR EACH ROW EXECUTE FUNCTION update_updated_at();

        DROP TRIGGER IF EXISTS trg_email_queue_updated_at ON email_queue;
        CREATE TRIGGER trg_email_queue_updated_at
            BEFORE UPDATE ON email_queue
            FOR EACH ROW EXECUTE FUNCTION update_updated_at();

        DROP TRIGGER IF EXISTS trg_scheduled_tests_updated_at ON scheduled_tests;
        CREATE TRIGGER trg_scheduled_tests_updated_at
            BEFORE UPDATE ON scheduled_tests
            FOR EACH ROW EXECUTE FUNCTION update_updated_at();
    END IF;
END $$;
