-- Migration: Add raw_response column to test_executions for Postman-style response viewer
-- Run against Railway DB: node run-migration.js <DATABASE_URL>

ALTER TABLE test_executions ADD COLUMN IF NOT EXISTS raw_response JSONB;

-- Add index for faster queries
CREATE INDEX IF NOT EXISTS idx_test_executions_raw_response ON test_executions USING GIN (raw_response) WHERE raw_response IS NOT NULL;

-- Comment for documentation
COMMENT ON COLUMN test_executions.raw_response IS 'Full HTTP response object: statusCode, statusText, headers, body, rawBody, responseTime, size';
