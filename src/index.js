/**
 * TestForge Backend v3.2 - Express Server Entry Point
 * Build: 2026-04-16T00:00:00Z
 *
 * Key guarantees:
 *   - Server starts even if individual route files have bugs.
 *   - /health and /api/health respond 200 without touching the DB so Railway
 *     healthchecks never kill the container.
 *   - Rate limiter is mounted correctly (default export is a middleware fn).
 *   - CORS supports multiple origins via comma-separated CORS_ORIGIN.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

const config = require('./config');
const logger = require('./utils/logger');
const { errorHandler } = require('./middleware/errorHandler');
const rateLimiter = require('./middleware/rateLimiter'); // default export = generalLimiter (a function)

const app = express();

// Build info for deployment verification
const BUILD_VERSION = '3.2.0';
const BUILD_DATE = '2026-05-21T07:00:00Z';

logger.info({ version: BUILD_VERSION, buildDate: BUILD_DATE }, 'TestForge Backend starting...');

// ============================================================================
// INLINE STARTUP MIGRATIONS — idempotent ALTER TABLE IF NOT EXISTS statements
// run on boot so Railway deploys don't need a separate migration step.
// ============================================================================
(async function runStartupMigrations() {
  try {
    const db = require('./db');
    const statements = [
      `ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS story_id INTEGER REFERENCES stories(id) ON DELETE SET NULL`,
      `ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS jira_issue_key VARCHAR(50)`,
      `ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL`,
      `CREATE TABLE IF NOT EXISTS folders (
         id SERIAL PRIMARY KEY,
         project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
         parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
         name VARCHAR(200) NOT NULL,
         position INTEGER DEFAULT 0,
         user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
         organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
         created_at TIMESTAMPTZ DEFAULT NOW(),
         updated_at TIMESTAMPTZ DEFAULT NOW()
       )`,
      `CREATE INDEX IF NOT EXISTS idx_folders_project_id ON folders(project_id)`,
      `CREATE INDEX IF NOT EXISTS idx_folders_parent_id ON folders(parent_id)`,
      `ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL`,
      `CREATE INDEX IF NOT EXISTS idx_test_cases_folder_id ON test_cases(folder_id)`,
      `ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS scenario_id INTEGER REFERENCES scenarios(id) ON DELETE SET NULL`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_test_cases_scenario_id_unique ON test_cases(scenario_id) WHERE scenario_id IS NOT NULL`,
      `CREATE TABLE IF NOT EXISTS test_runs (
         id SERIAL PRIMARY KEY,
         project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
         name VARCHAR(300) NOT NULL,
         description TEXT,
         state VARCHAR(40) NOT NULL DEFAULT 'new',
         assignee_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
         tags JSONB DEFAULT '[]'::jsonb,
         test_case_ids JSONB DEFAULT '[]'::jsonb,
         configurations JSONB DEFAULT '{}'::jsonb,
         run_group VARCHAR(200),
         test_plan VARCHAR(200),
         auto_assign BOOLEAN DEFAULT false,
         user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
         organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
         created_at TIMESTAMPTZ DEFAULT NOW(),
         updated_at TIMESTAMPTZ DEFAULT NOW()
       )`,
      `CREATE INDEX IF NOT EXISTS idx_test_runs_project_id ON test_runs(project_id)`,
      `CREATE INDEX IF NOT EXISTS idx_test_runs_state ON test_runs(state)`,
      `CREATE TABLE IF NOT EXISTS test_run_results (
         id SERIAL PRIMARY KEY,
         test_run_id INTEGER NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
         test_case_id INTEGER NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
         status VARCHAR(20) NOT NULL DEFAULT 'untested',
         comment TEXT,
         executed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
         executed_at TIMESTAMPTZ,
         created_at TIMESTAMPTZ DEFAULT NOW(),
         updated_at TIMESTAMPTZ DEFAULT NOW(),
         UNIQUE(test_run_id, test_case_id)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_test_run_results_run_id ON test_run_results(test_run_id)`,
      `CREATE INDEX IF NOT EXISTS idx_test_run_results_status ON test_run_results(status)`,
      `ALTER TABLE test_run_results ADD COLUMN IF NOT EXISTS step_results JSONB DEFAULT '[]'::jsonb`,
      `ALTER TABLE test_run_results ADD COLUMN IF NOT EXISTS assignee_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL`,
      `ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS assignee_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL`,
      `ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ`,
      `ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`,
      `ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS jira_issue_key VARCHAR(50)`,
      `CREATE INDEX IF NOT EXISTS idx_test_cases_story_id ON test_cases(story_id)`,
      `CREATE INDEX IF NOT EXISTS idx_test_cases_jira_issue_key ON test_cases(jira_issue_key)`,
      `CREATE INDEX IF NOT EXISTS idx_test_cases_organization_id ON test_cases(organization_id)`,
      `CREATE INDEX IF NOT EXISTS idx_scenarios_jira_issue_key ON scenarios(jira_issue_key)`,
      `UPDATE test_cases tc SET organization_id = u.organization_id FROM users u
         WHERE tc.user_id = u.id AND u.organization_id IS NOT NULL AND tc.organization_id IS NULL`,

      // ── Migration 011: org-wide visibility for projects/collections/environments/schedules/run_reports ──
      `ALTER TABLE projects ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL`,
      `CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(organization_id)`,
      `UPDATE projects p SET organization_id = u.organization_id FROM users u
         WHERE p.user_id = u.id AND u.organization_id IS NOT NULL AND p.organization_id IS NULL`,

      `ALTER TABLE collections ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL`,
      `CREATE INDEX IF NOT EXISTS idx_collections_org ON collections(organization_id)`,
      `UPDATE collections c SET organization_id = u.organization_id FROM users u
         WHERE c.user_id = u.id AND u.organization_id IS NOT NULL AND c.organization_id IS NULL`,

      `ALTER TABLE environments ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL`,
      `CREATE INDEX IF NOT EXISTS idx_environments_org ON environments(organization_id)`,
      `UPDATE environments e SET organization_id = u.organization_id FROM users u
         WHERE e.user_id = u.id AND u.organization_id IS NOT NULL AND e.organization_id IS NULL`,

      `ALTER TABLE scheduled_tests ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL`,
      `CREATE INDEX IF NOT EXISTS idx_scheduled_tests_org ON scheduled_tests(organization_id)`,
      `UPDATE scheduled_tests s SET organization_id = u.organization_id FROM users u
         WHERE s.user_id = u.id AND u.organization_id IS NOT NULL AND s.organization_id IS NULL`,

      `ALTER TABLE run_reports ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL`,
      `CREATE INDEX IF NOT EXISTS idx_run_reports_org ON run_reports(organization_id)`,
      `UPDATE run_reports r SET organization_id = u.organization_id FROM users u
         WHERE r.user_id = u.id AND u.organization_id IS NOT NULL AND r.organization_id IS NULL`,

      // ── Reconcile 006 team-mgmt columns/tables ──
      // Migration 006 used CREATE TABLE IF NOT EXISTS for `organizations`
      // assuming the table didn't yet exist. On any DB where the table was
      // already present (1711756800000_initial-schema.sql created it), the
      // new columns silently never landed. These idempotent ALTERs close
      // that gap so register/login work on a DB that's been live since
      // the early schema without needing a manual backfill.
      `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS logo_url TEXT`,
      `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}'::jsonb`,
      `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS domain_restriction_enabled BOOLEAN NOT NULL DEFAULT false`,
      `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_by INTEGER REFERENCES users(id) ON DELETE SET NULL`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ`,
      `CREATE TABLE IF NOT EXISTS organization_members (
         id SERIAL PRIMARY KEY,
         organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
         user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         role TEXT NOT NULL DEFAULT 'member',
         invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
         joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         UNIQUE(organization_id, user_id)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_organization_members_org ON organization_members(organization_id)`,
      `CREATE INDEX IF NOT EXISTS idx_organization_members_user ON organization_members(user_id)`,
      `CREATE TABLE IF NOT EXISTS allowed_email_domains (
         id SERIAL PRIMARY KEY,
         organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
         domain TEXT NOT NULL,
         created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         UNIQUE(organization_id, domain)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_allowed_email_domains_org ON allowed_email_domains(organization_id)`,

      // ── Migration 012: platform-wide audit log columns ──
      `CREATE TABLE IF NOT EXISTS team_audit_logs (
         id SERIAL PRIMARY KEY,
         organization_id INTEGER NOT NULL,
         actor_id INTEGER,
         action TEXT NOT NULL,
         target_type TEXT,
         target_id TEXT,
         details JSONB DEFAULT '{}'::jsonb,
         ip_address TEXT,
         user_agent TEXT,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
      `ALTER TABLE team_audit_logs ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'success'`,
      `ALTER TABLE team_audit_logs ADD COLUMN IF NOT EXISTS ip_address TEXT`,
      `ALTER TABLE team_audit_logs ADD COLUMN IF NOT EXISTS user_agent TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_team_audit_logs_org ON team_audit_logs(organization_id)`,
      `CREATE INDEX IF NOT EXISTS idx_team_audit_logs_actor ON team_audit_logs(actor_id)`,
      `CREATE INDEX IF NOT EXISTS idx_team_audit_logs_action ON team_audit_logs(action)`,
      `CREATE INDEX IF NOT EXISTS idx_team_audit_logs_created ON team_audit_logs(created_at DESC)`,

      // ── API request chaining: per-collection auto cookie jar toggle ──
      `ALTER TABLE collections ADD COLUMN IF NOT EXISTS auto_cookie_jar BOOLEAN NOT NULL DEFAULT false`,

      // ── Migration 014: org-scoped Jira OAuth client credentials ──
      // Lets each organisation register its own Atlassian OAuth2 (3LO) app
      // from the admin UI instead of requiring a deploy-time env var. The
      // env vars (JIRA_CLIENT_ID/SECRET/REDIRECT_URI) remain a fallback so
      // self-hosted single-tenant deployments keep working unchanged.
      `CREATE TABLE IF NOT EXISTS jira_oauth_config (
         organization_id INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
         client_id TEXT NOT NULL,
         client_secret TEXT NOT NULL,
         redirect_uri TEXT NOT NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
       )`,

      // ── Migration 015: persistent chain sessions ──
      // Keeps the per-(user, collection) cookie jar + chainVars across
      // backend restarts so individual ▶ debugging doesn't lose state when
      // Render redeploys a dyno. The in-memory cache stays the hot path;
      // this table is hydrated on miss and written-through on mutation.
      `CREATE TABLE IF NOT EXISTS chain_sessions (
         user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
         jar_json JSONB NOT NULL,
         chain_vars JSONB NOT NULL DEFAULT '{}'::jsonb,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         PRIMARY KEY (user_id, collection_id)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_chain_sessions_updated ON chain_sessions(updated_at)`,

      // ── Migration 017: API source import (catalog, versions, endpoints) ──
      `CREATE TABLE IF NOT EXISTS api_sources (
         id SERIAL PRIMARY KEY,
         user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
         organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
         name VARCHAR(300) NOT NULL,
         protocol VARCHAR(40) NOT NULL DEFAULT 'rest',
         format VARCHAR(40) NOT NULL,
         spec_version VARCHAR(40),
         source_url TEXT,
         servers JSONB NOT NULL DEFAULT '[]'::jsonb,
         auth_schemes JSONB NOT NULL DEFAULT '[]'::jsonb,
         refresh_policy JSONB NOT NULL DEFAULT '{"mode":"manual"}'::jsonb,
         lifecycle_state VARCHAR(20) NOT NULL DEFAULT 'active',
         provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
         endpoint_count INTEGER NOT NULL DEFAULT 0,
         last_fetched_at TIMESTAMPTZ,
         parsed_at TIMESTAMPTZ,
         current_version_id INTEGER,
         parent_source_id INTEGER REFERENCES api_sources(id) ON DELETE SET NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         deleted_at TIMESTAMPTZ
       )`,
      `CREATE INDEX IF NOT EXISTS idx_api_sources_user ON api_sources(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_api_sources_org  ON api_sources(organization_id)`,
      `CREATE TABLE IF NOT EXISTS api_source_versions (
         id SERIAL PRIMARY KEY,
         source_id INTEGER NOT NULL REFERENCES api_sources(id) ON DELETE CASCADE,
         content_address VARCHAR(80) NOT NULL,
         raw_size_bytes INTEGER,
         parser_version VARCHAR(40),
         endpoint_count INTEGER NOT NULL DEFAULT 0,
         change_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
         fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         parsed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
      `CREATE INDEX IF NOT EXISTS idx_api_source_versions_source ON api_source_versions(source_id, fetched_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_api_source_versions_address ON api_source_versions(content_address)`,
      `CREATE TABLE IF NOT EXISTS api_endpoints (
         id SERIAL PRIMARY KEY,
         source_id INTEGER NOT NULL REFERENCES api_sources(id) ON DELETE CASCADE,
         organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
         protocol VARCHAR(40) NOT NULL DEFAULT 'rest',
         operation_id VARCHAR(300),
         fingerprint VARCHAR(80) NOT NULL,
         method VARCHAR(10) NOT NULL,
         path TEXT NOT NULL,
         summary TEXT,
         description TEXT,
         tags JSONB NOT NULL DEFAULT '[]'::jsonb,
         auth_requirement JSONB NOT NULL DEFAULT '[]'::jsonb,
         request_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
         response_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
         sample_request JSONB NOT NULL DEFAULT '{}'::jsonb,
         bindings JSONB NOT NULL DEFAULT '{}'::jsonb,
         examples JSONB NOT NULL DEFAULT '[]'::jsonb,
         vendor_extensions JSONB NOT NULL DEFAULT '{}'::jsonb,
         stability VARCHAR(20) NOT NULL DEFAULT 'stable',
         first_seen_version_id INTEGER REFERENCES api_source_versions(id) ON DELETE SET NULL,
         last_seen_version_id INTEGER REFERENCES api_source_versions(id) ON DELETE SET NULL,
         deprecated_at TIMESTAMPTZ,
         removed_at TIMESTAMPTZ,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
      `CREATE INDEX IF NOT EXISTS idx_api_endpoints_source ON api_endpoints(source_id)`,
      `CREATE INDEX IF NOT EXISTS idx_api_endpoints_org    ON api_endpoints(organization_id)`,
      `CREATE INDEX IF NOT EXISTS idx_api_endpoints_fp     ON api_endpoints(fingerprint)`,
      `CREATE INDEX IF NOT EXISTS idx_api_endpoints_method ON api_endpoints(method)`,

      // ── Migration 018: repair stories/scenarios FK types ──
      // Original migration 001 declared stories.project_id and user_id as
      // UUID, but projects.id and users.id are SERIAL (integer). The
      // CREATE TABLE failed in production due to FK type incompatibility,
      // leaving stories/scenarios missing and breaking GET /stories with
      // 500. This block:
      //   1. Drops the legacy tables ONLY if they exist with UUID columns
      //      (idempotent — won't touch correct schemas on subsequent runs).
      //   2. Recreates with INTEGER FKs.
      //   3. Replays migration 010's test_cases.story_id ADD COLUMN that
      //      would have failed when stories was missing.
      // Drop stories/scenarios if they exist with ANY column type that
      // would prevent the route from running — i.e. project_id is not
      // INTEGER. Original check only caught the 'uuid' case, but in
      // practice the column could be 'text', 'character varying', etc.
      // depending on how the partial migration left the table.
      `DO $mig018$
       DECLARE
         pid_type text;
       BEGIN
         SELECT data_type INTO pid_type
         FROM information_schema.columns
         WHERE table_name = 'stories' AND column_name = 'project_id';

         IF pid_type IS NULL THEN
           RAISE NOTICE 'Migration 018: stories table does not exist; CREATE TABLE will create it';
         ELSIF pid_type <> 'integer' THEN
           RAISE NOTICE 'Migration 018: stories.project_id is %; dropping for recreate', pid_type;
           DROP TABLE IF EXISTS scenarios CASCADE;
           DROP TABLE IF EXISTS stories CASCADE;
         ELSE
           RAISE NOTICE 'Migration 018: stories.project_id is already integer; skipping drop';
         END IF;
       END
       $mig018$`,
      `CREATE TABLE IF NOT EXISTS stories (
         id SERIAL PRIMARY KEY,
         project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
         user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         title TEXT NOT NULL,
         description TEXT NOT NULL,
         source_type TEXT NOT NULL DEFAULT 'text' CHECK (source_type IN ('text','url')),
         source_url TEXT,
         status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','extracted','reviewed','exported')),
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
      `CREATE TABLE IF NOT EXISTS scenarios (
         id SERIAL PRIMARY KEY,
         story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
         project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
         user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         category TEXT NOT NULL CHECK (category IN (
           'happy_path','negative','edge','validation',
           'role_permission','state_transition','api_impact','non_functional'
         )),
         title TEXT NOT NULL,
         summary TEXT,
         preconditions JSONB DEFAULT '[]'::jsonb,
         test_intent TEXT,
         inputs JSONB DEFAULT '{}'::jsonb,
         expected_outcome TEXT,
         priority TEXT NOT NULL DEFAULT 'P1' CHECK (priority IN ('P0','P1','P2','P3')),
         status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
         review_note TEXT,
         jira_issue_key VARCHAR(50),
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
      `CREATE INDEX IF NOT EXISTS idx_stories_project_user ON stories(project_id, user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_stories_project ON stories(project_id)`,
      `CREATE INDEX IF NOT EXISTS idx_scenarios_story ON scenarios(story_id)`,
      `CREATE INDEX IF NOT EXISTS idx_scenarios_story_status ON scenarios(story_id, status)`,
      `CREATE INDEX IF NOT EXISTS idx_scenarios_project ON scenarios(project_id)`,
      `CREATE INDEX IF NOT EXISTS idx_scenarios_jira_key ON scenarios(jira_issue_key)`,
      // test_cases.story_id was supposed to land via migration 010 but
      // would have failed if stories didn't exist yet. Replay safely now.
      `ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS story_id INTEGER REFERENCES stories(id) ON DELETE SET NULL`,
      `CREATE INDEX IF NOT EXISTS idx_test_cases_story_id ON test_cases(story_id)`,

      // ── Migration 019: platform admin + org status/features + cross-org audit ──
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_admin BOOLEAN NOT NULL DEFAULT false`,
      `CREATE INDEX IF NOT EXISTS idx_users_platform_admin ON users(is_platform_admin) WHERE is_platform_admin = true`,
      `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`,
      `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ`,
      `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS suspension_reason TEXT`,
      `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS features JSONB NOT NULL DEFAULT '{}'::jsonb`,
      `CREATE INDEX IF NOT EXISTS idx_organizations_status ON organizations(status)`,
      `CREATE TABLE IF NOT EXISTS platform_audit_logs (
         id SERIAL PRIMARY KEY,
         actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
         actor_email TEXT,
         action TEXT NOT NULL,
         target_type TEXT,
         target_id TEXT,
         target_org_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
         details JSONB DEFAULT '{}'::jsonb,
         ip_address TEXT,
         user_agent TEXT,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
      `CREATE INDEX IF NOT EXISTS idx_platform_audit_actor ON platform_audit_logs(actor_id)`,
      `CREATE INDEX IF NOT EXISTS idx_platform_audit_org ON platform_audit_logs(target_org_id)`,
      `CREATE INDEX IF NOT EXISTS idx_platform_audit_created ON platform_audit_logs(created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_platform_audit_action ON platform_audit_logs(action)`,

      // ── Migration 020: public multi-tenant signup ──
      // users.email_verified_at — null until verification link clicked.
      // Existing rows are grandfathered to created_at (trusted pre-flow).
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ`,
      `UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL`,
      `CREATE INDEX IF NOT EXISTS idx_users_email_verified ON users(email_verified_at) WHERE email_verified_at IS NULL`,
      // organizations.created_via for audit; verified_at gates domain claim
      `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS created_via TEXT NOT NULL DEFAULT 'admin' CHECK (created_via IN ('first_user', 'signup', 'invite', 'admin'))`,
      `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ`,
      `UPDATE organizations SET verified_at = created_at WHERE verified_at IS NULL`,
      `UPDATE organizations SET created_via = 'first_user' WHERE id = 1 AND created_via = 'admin'`,
      // Single-use verification tokens, hashed at rest
      `CREATE TABLE IF NOT EXISTS email_verification_tokens (
         id SERIAL PRIMARY KEY,
         user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         token_hash TEXT NOT NULL,
         purpose TEXT NOT NULL DEFAULT 'signup' CHECK (purpose IN ('signup', 'email_change')),
         expires_at TIMESTAMPTZ NOT NULL,
         used_at TIMESTAMPTZ,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_email_verif_token_hash ON email_verification_tokens(token_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_email_verif_user ON email_verification_tokens(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_email_verif_expires ON email_verification_tokens(expires_at) WHERE used_at IS NULL`,
      // Race-safe domain claim: pending orgs (verified_at NULL) don't compete.
      // First org to verify locks the domain; the second one's verify fails.
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_verified_domain
         ON organizations(LOWER(domain))
         WHERE verified_at IS NOT NULL AND domain IS NOT NULL AND domain <> ''`,

      // ── Migration 021: two-factor auth (TOTP) ──
      // Login-flow gating ships separately; this only stores the secret + codes.
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret_enc TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled_at TIMESTAMPTZ`,
      `CREATE INDEX IF NOT EXISTS idx_users_totp_enabled ON users(totp_enabled_at) WHERE totp_enabled_at IS NOT NULL`,
      `CREATE TABLE IF NOT EXISTS user_recovery_codes (
         id SERIAL PRIMARY KEY,
         user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         code_hash TEXT NOT NULL,
         used_at TIMESTAMPTZ,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_user_recovery_codes_hash ON user_recovery_codes(code_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_user_recovery_codes_user ON user_recovery_codes(user_id) WHERE used_at IS NULL`,
    ];
    for (const sql of statements) {
      try {
        await db.query(sql);
      } catch (err) {
        logger.warn({ err: err.message, sql: sql.slice(0, 80) }, 'Startup migration statement failed (continuing)');
      }
    }
    logger.info('Startup migrations complete');

    // Post-migration verification — surface the actual state of the
    // stories/scenarios tables AND run the exact query the GET /stories
    // route uses so we can spot the real cause of any 500 without
    // needing authenticated reproduction.
    try {
      const schemaProbe = await db.query(`
        SELECT table_name, column_name, data_type
        FROM information_schema.columns
        WHERE table_name IN ('stories', 'scenarios')
        ORDER BY table_name, column_name
      `);
      if (schemaProbe.rows.length === 0) {
        logger.error('Migration 018 verification: stories AND scenarios tables BOTH MISSING after migrations ran');
      } else {
        logger.info({ columns: schemaProbe.rows }, 'Migration 018 verification: schema snapshot');
      }

      // Reproduce the route's query with a no-op WHERE clause so it
      // exercises every reference (FROM stories, subquery on scenarios,
      // ORDER BY created_at) without needing real data.
      try {
        await db.query(`
          SELECT s.*,
            (SELECT count(*) FROM scenarios sc WHERE sc.story_id = s.id)::int AS scenario_count,
            (SELECT count(*) FROM scenarios sc WHERE sc.story_id = s.id AND sc.status = 'approved')::int AS approved_count
          FROM stories s
          WHERE s.project_id = -1
          ORDER BY s.created_at DESC
          LIMIT 0
        `);
        logger.info('Migration 018 verification: route query EXECUTES cleanly');
      } catch (queryErr) {
        logger.error({ err: queryErr.message, code: queryErr.code }, 'Migration 018 verification: route query FAILED');
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'Migration 018 verification probe failed');
    }
  } catch (err) {
    logger.error({ err: err.message }, 'Startup migrations failed to run');
  }
})();

// ============================================================================
// LIGHTWEIGHT HEALTHCHECKS — mounted BEFORE everything else so Railway's
// healthcheck always passes regardless of DB/route state.
// ============================================================================
app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    app: 'testforge-backend',
    version: BUILD_VERSION,
    timestamp: new Date().toISOString(),
  });
});
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// ============================================================================
// SAFE ROUTE LOADER — won't crash if a route file has issues
// ============================================================================
function safeRequire(modulePath, name) {
  try {
    const mod = require(modulePath);
    logger.info({ route: name }, `Route loaded: ${name}`);
    return mod;
  } catch (err) {
    logger.error({ err: err.message, route: name, stack: err.stack }, `Failed to load route: ${name}`);
    const { Router } = require('express');
    const fallbackRouter = Router();
    fallbackRouter.all('*', (_req, res) => {
      res.status(503).json({
        error: { code: 'ROUTE_UNAVAILABLE', message: `${name} routes temporarily unavailable` },
      });
    });
    return fallbackRouter;
  }
}

// ============================================================================
// LOAD ALL ROUTES
// ============================================================================
const authRoutes = safeRequire('./routes/auth', 'auth');
const twoFactorRoutes = safeRequire('./routes/twoFactor', 'twoFactor');
const projectRoutes = safeRequire('./routes/projects', 'projects');
const testcaseRoutes = safeRequire('./routes/testcases', 'testcases');
const analyzeRoutes = safeRequire('./routes/analyze', 'analyze');
const storyRoutes = safeRequire('./routes/stories', 'stories');
const playwrightRoutes = safeRequire('./routes/playwright', 'playwright');
const executeRoutes = safeRequire('./routes/execute', 'execute');
const automationAssetRoutes = safeRequire('./routes/automationAssets', 'automationAssets');
const targetConfigRoutes = safeRequire('./routes/targetAppConfig', 'targetAppConfig');
const healthRoutes = safeRequire('./routes/health', 'health');
const screenshotRoutes = safeRequire('./routes/screenshots', 'screenshots');
const teamRoutes = safeRequire('./routes/team', 'team');
const environmentRoutes = safeRequire('./routes/environments', 'environments');
const collectionRoutes = safeRequire('./routes/collections', 'collections');
const scheduleRoutes = safeRequire('./routes/schedules', 'schedules');
const reportRoutes = safeRequire('./routes/reports', 'reports');
const dashboardRoutes = safeRequire('./routes/dashboard', 'dashboard');
const runReportRoutes = safeRequire('./routes/run-reports', 'run-reports');
const globalsRoutes = safeRequire('./routes/globals', 'globals');
const sharingRoutes = safeRequire('./routes/sharing', 'sharing');
const jiraRoutes = safeRequire('./routes/jira', 'jira');
const folderRoutes = safeRequire('./routes/folders', 'folders');
const testRunRoutes = safeRequire('./routes/testRuns', 'testRuns');
const runsTopLevelRoutes = safeRequire('./routes/runs', 'runs');
const projectInsightsRoutes = safeRequire('./routes/projectInsights', 'projectInsights');
const webhookRoutes = safeRequire('./routes/webhooks', 'webhooks');
const apiSourceRoutes = safeRequire('./routes/apiSources', 'apiSources');
const adminRoutes = safeRequire('./routes/admin', 'admin');
const autofixRoutes = safeRequire('./routes/autofix', 'autofix');

// ============================================================================
// CORS — credentials: true so the HttpOnly refresh cookie flows on /auth/refresh
// and /auth/logout. This forbids origin: '*' — CORS_ORIGIN MUST be set to a
// concrete allow-list in any environment that serves real users.
// ============================================================================
function buildCorsOptions() {
  const raw = process.env.CORS_ORIGIN || '*';
  if (raw === '*') {
    // Wildcard mode is incompatible with credentialed requests. Keep it for
    // unauthenticated dev/health pings only — credentialed fetches will fail
    // and surface the misconfig immediately rather than silently leaking.
    logger.warn('CORS_ORIGIN is "*" — credentialed requests will be rejected. Set an allow-list.');
    return { origin: '*', credentials: false, maxAge: 86400 };
  }

  const allowList = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return {
    origin(origin, cb) {
      // Allow same-origin / curl / server-to-server (no Origin header).
      if (!origin) return cb(null, true);
      if (allowList.includes(origin)) return cb(null, true);
      // Also allow any *.vercel.app preview URL when vercel.app is listed.
      if (allowList.some((a) => a.endsWith('.vercel.app')) && /\.vercel\.app$/.test(new URL(origin).hostname)) {
        return cb(null, true);
      }
      logger.warn({ origin }, 'CORS: origin not allowed');
      return cb(null, false);
    },
    credentials: true,
    maxAge: 86400,
  };
}
// Security headers. This is a JSON API, not an HTML site, so:
//   - contentSecurityPolicy is disabled (no HTML/inline scripts to lock down).
//   - crossOriginResourcePolicy is relaxed to 'cross-origin' so legitimate
//     frontend consumers on a different origin can fetch responses.
// Helmet still sets HSTS, X-Content-Type-Options, X-DNS-Prefetch-Control,
// Referrer-Policy, and other safe defaults.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors(buildCorsOptions()));
// cors middleware automatically handles OPTIONS preflight for all routes.

// ============================================================================
// BODY PARSING + GLOBAL RATE LIMIT
// ============================================================================
// GitHub webhook handlers need the raw request body to recompute the HMAC
// over the exact bytes GitHub signed. Stashing buf on req for /api/webhooks/*
// only — keeps memory cost off every other request.
app.use(express.json({
  limit: '10mb',
  verify: (req, _res, buf) => {
    if (req.url && req.url.startsWith('/api/webhooks/')) {
      req.rawBody = buf;
    }
  },
}));
// rateLimiter is the generalLimiter middleware (default export). It skips
// /health, /healthz, /api/health and /api/version automatically.
app.use(rateLimiter);

// Request logging — pino-http auto-generates a req.id, captures method/url/
// status/latency in a single completion log line, and exposes `req.log` for
// downstream handlers to use (so per-request context propagates to error logs).
const pinoHttp = require('pino-http');
app.use(pinoHttp({
  logger,
  // Don't spam logs with healthcheck pings or version probes.
  autoLogging: {
    ignore: (req) =>
      req.url === '/health' ||
      req.url === '/healthz' ||
      req.url === '/api/health' ||
      req.url === '/api/version',
  },
  // Surface request ID in responses for client/server log correlation.
  customAttributeKeys: { responseTime: 'durationMs' },
  serializers: {
    // SSE/EventSource endpoints accept ?token=<jwt> in the query string. Scrub
    // it before logging — otherwise JWTs land in production logs verbatim.
    req: (req) => ({
      id: req.id,
      method: req.method,
      url: typeof req.url === 'string' ? req.url.replace(/([?&]token=)[^&]+/g, '$1REDACTED') : req.url,
    }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
}));

// Audit middleware — attaches req.audit() and auto-logs mutating CRUD calls.
const { auditMiddleware } = require('./middleware/auditMiddleware');
app.use(auditMiddleware);

// ============================================================================
// VERSION ENDPOINT — for deployment verification
// ============================================================================
app.get('/api/version', (_req, res) => {
  res.json({
    version: BUILD_VERSION,
    buildDate: BUILD_DATE,
    status: 'running',
    timestamp: new Date().toISOString(),
  });
});

// ============================================================================
// MOUNT ROUTES
// ============================================================================

// Health at /api/health (routes/health.js defines `router.get('/', ...)`)
app.use('/api/health', healthRoutes);

// Auth routes (no auth middleware — register/login/refresh/logout are public)
app.use('/api/auth', authRoutes);
if (twoFactorRoutes) app.use('/api/auth/2fa', twoFactorRoutes);

// Platform admin (cross-org). Mount early so a 401/403 is returned before
// org-scoped routes get a chance to redirect on missing orgId.
app.use('/api/admin', adminRoutes);
if (autofixRoutes) app.use('/api/autofix', autofixRoutes);

// Protected routes — specific paths first
app.use('/api/projects', projectRoutes);
// Folders — scoped under a project
app.use('/api/projects/:projectId/folders', folderRoutes);
app.use('/api/projects/:projectId/test-runs', testRunRoutes);
if (runsTopLevelRoutes) app.use('/api/runs', runsTopLevelRoutes);
app.use('/api/projects/:projectId/insights', projectInsightsRoutes);
// Test cases — support both the flat legacy mount and the nested project-scoped mount
app.use('/api/projects/:projectId/testcases', testcaseRoutes);
app.use('/api/testcases', testcaseRoutes);
app.use('/api/analyze', analyzeRoutes);
// Stories and target-config routers use mergeParams and read req.params.projectId
app.use('/api/projects/:projectId/stories', storyRoutes);
app.use('/api/projects/:projectId/target-config', targetConfigRoutes);
// Legacy/top-level mount for stories (for pages that don't have a projectId in URL)
app.use('/api/stories', storyRoutes);
app.use('/api/playwright', playwrightRoutes);
app.use('/api/automation-assets', automationAssetRoutes);
app.use('/api/team', teamRoutes);
app.use('/api/environments', environmentRoutes);
app.use('/api/collections', collectionRoutes);
app.use('/api/sources', apiSourceRoutes);
app.use('/api/schedules', scheduleRoutes);
app.use('/api/reports', reportRoutes);

// Dashboard
logger.info('Mounting dashboard routes at /api/dashboard');
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/run-reports', runReportRoutes);
app.use('/api/globals', globalsRoutes);
app.use('/api/jira', jiraRoutes);
// Sharing is mounted as a sub-router on collections: /api/collections/:id/share
// sharing router uses mergeParams to read req.params.id
app.use('/api/collections/:id/share', sharingRoutes);

// Webhooks — public (HMAC-verified inside the handler), no auth middleware.
app.use('/api/webhooks', webhookRoutes);

// Execute routes LAST — mounted at /api with `router.use(authenticate)` inside.
app.use('/api', executeRoutes);

// Screenshots — both as route and static fallback from disk
app.use('/api/screenshots', screenshotRoutes);
app.use('/api/screenshots', express.static(path.join(__dirname, '..', 'screenshots')));

// ============================================================================
// 404 + ERROR HANDLING (conventional Express order)
// ============================================================================

// 404 handler — catch-all for unmatched routes, returns standard error shape
app.use((req, res) => {
  logger.warn({ method: req.method, url: req.url }, '404 - Endpoint not found');
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: 'Endpoint not found',
      path: req.url,
    },
  });
});

// Error handler must be registered last (must have 4-arg signature)
app.use(errorHandler);

// ============================================================================
// START SERVER
// ============================================================================
const PORT = process.env.PORT || config.PORT || 3000;

// Only bind a port when this file is the entry point. When `src/index.js` is
// `require()`d as a module (e.g. supertest in integration tests calling
// `require('../src/index')`), starting a listener would race with the next
// test file's require and surface as `EADDRINUSE: 0.0.0.0:3001`. The bound
// server isn't even used by supertest — supertest spins up its own ephemeral
// listener from the express app instance.
let server = null;
if (require.main === module) {
  server = app.listen(PORT, '0.0.0.0', () => {
    logger.info(
      {
        port: PORT,
        version: BUILD_VERSION,
        buildDate: BUILD_DATE,
        env: process.env.NODE_ENV || 'development',
      },
      `TestForge server v${BUILD_VERSION} started on port ${PORT}`
    );
  });
  // Background job: sweep abandoned pending signups (>7d). Daily.
  // Only when running as a real server — supertest imports of this
  // module shouldn't spin up the interval.
  try {
    require('./services/signupJanitor').start();
  } catch (err) {
    logger.warn({ err: err.message }, 'signup janitor failed to start (continuing)');
  }
  // Auto-fix loop: claim open test_failures rows, run propose -> apply -> verify.
  // Gated by AUTOFIX_CRON_ENABLED=1 (default off — opt-in so dev boxes don't
  // burn LLM credits the moment they touch the DB). Schedule overridable via
  // AUTOFIX_CRON_SCHEDULE (default '*/15 * * * *').
  try {
    require('./services/autoFixCronService').start();
  } catch (err) {
    logger.warn({ err: err.message }, 'autofix cron failed to start (continuing)');
  }
}

// Graceful shutdown so Railway doesn't SIGKILL mid-request
function shutdown(signal) {
  logger.info({ signal }, 'Received shutdown signal, closing server...');
  if (server) {
    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
  // Force-exit if graceful close takes too long
  setTimeout(() => {
    logger.warn('Force-exiting after 10s shutdown timeout');
    process.exit(1);
  }, 10000).unref();
}
// Only wire signal handlers when we actually own the server lifecycle.
if (require.main === module) {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Never crash on unhandled rejections — log and keep serving
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  logger.error({ err: err.message, stack: err.stack }, 'Uncaught exception');
});

module.exports = app;
