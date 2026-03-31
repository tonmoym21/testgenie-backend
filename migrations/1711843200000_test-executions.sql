-- Up Migration

CREATE TABLE test_executions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    test_name TEXT NOT NULL,
    test_type TEXT NOT NULL CHECK (test_type IN ('ui', 'api')),
    test_definition JSONB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'running', 'error')),
    error TEXT,
    duration_ms INTEGER,
    logs JSONB DEFAULT '[]',
    screenshots JSONB DEFAULT '[]',
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_test_executions_user_id ON test_executions(user_id);
CREATE INDEX idx_test_executions_project_id ON test_executions(project_id);
CREATE INDEX idx_test_executions_status ON test_executions(status);
CREATE INDEX idx_test_executions_created_at ON test_executions(created_at DESC);

-- Down Migration

DROP TABLE IF EXISTS test_executions;
