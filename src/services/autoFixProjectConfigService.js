// src/services/autoFixProjectConfigService.js
// Read + upsert for project_autofix_configs (migration 023). One
// column today (daily_limit), schema designed to grow — when we add
// max_retries_per_failure or an enabled toggle, the same UPSERT
// pattern extends with one more named field.
//
// Read returns the effective resolved limit alongside the raw column.
// That's what the dashboard's "Project settings" panel wants to show:
//   "Daily limit: 50 (override) — env default would have been 20"
//   "Daily limit: (using env default of 20)"
// Without the resolved value the UI would have to know about
// AUTOFIX_DAILY_LIMIT independently and recompute.

const { NotFoundError } = require('../utils/apiError');
const { getEnvDailyLimit } = require('./autoFixService');
const { getEnvMaxRetries } = require('./autoFixVerifyService');

/**
 * Read the per-project autofix config plus the env default and the
 * effective resolved value. The 404 here is "project doesn't exist,"
 * not "no config row" — a missing config row is a legitimate state
 * meaning "use env default, enabled by default."
 *
 * Response shape:
 *   {
 *     projectId,
 *     dailyLimit: <int|null>,        raw column (null = no override)
 *     effectiveDailyLimit: int,      what the autofix loop will actually use
 *     envDailyLimit: int,            env-level fallback (UI can render
 *                                    "using env default" vs override)
 *     maxRetriesPerFailure: <int|null>,  PR #34 raw column
 *     effectiveMaxRetriesPerFailure: int,
 *     envMaxRetriesPerFailure: int,
 *     enabled: boolean,              PR #33 toggle. true when no row exists.
 *     createdAt, updatedAt
 *   }
 */
async function getConfig(projectIdRaw, deps = {}) {
  const db = deps.db || require('../db');
  const projectId = Number(projectIdRaw);
  if (!Number.isFinite(projectId) || projectId <= 0) {
    throw new NotFoundError('project');
  }

  // Verify the project exists FIRST so a missing config doesn't get
  // confused with a missing project. Two queries on the read path is
  // cheap (single-row PK lookups); both go through pg connection
  // pooling.
  const projectRes = await db.query(
    `SELECT 1 FROM projects WHERE id = $1`,
    [projectId]
  );
  if (projectRes.rows.length === 0) {
    throw new NotFoundError('project');
  }

  const cfgRes = await db.query(
    `SELECT daily_limit, enabled, max_retries_per_failure, created_at, updated_at
       FROM project_autofix_configs
      WHERE project_id = $1`,
    [projectId]
  );
  const cfg = cfgRes.rows[0] || null;
  return shapeConfig(projectId, cfg);
}

// Shared response shaper — merges env defaults onto the raw row.
// Used by both getConfig (cfg may be null) and upsertConfig (cfg is
// always the RETURNING row). Keeping it pure (no DB access) lets the
// upsert path skip the second read entirely.
function shapeConfig(projectId, cfg) {
  const envDailyLimit = getEnvDailyLimit();
  const envMaxRetries = getEnvMaxRetries();
  const dailyLimit = cfg ? cfg.daily_limit : null;
  const maxRetriesPerFailure = cfg ? cfg.max_retries_per_failure : null;
  return {
    projectId,
    dailyLimit,
    effectiveDailyLimit: dailyLimit != null ? dailyLimit : envDailyLimit,
    envDailyLimit,
    maxRetriesPerFailure,
    effectiveMaxRetriesPerFailure: maxRetriesPerFailure != null ? maxRetriesPerFailure : envMaxRetries,
    envMaxRetriesPerFailure: envMaxRetries,
    enabled: cfg ? cfg.enabled : true,  // default TRUE preserves pre-#33 behavior
    createdAt: cfg ? cfg.created_at : null,
    updatedAt: cfg ? cfg.updated_at : null,
  };
}

/**
 * Upsert the config row. PUT semantics: caller sends BOTH dailyLimit
 * and enabled — replace, not patch. The frontend does GET-then-PUT
 * (standard REST); the race window is bounded because only ops touch
 * this endpoint, very infrequently. Explicit null in body.dailyLimit
 * clears the override.
 *
 * @param {number} projectIdRaw
 * @param {object} body
 * @param {number|null} body.dailyLimit            0..2_000_000_000 or null
 * @param {boolean}     body.enabled               false = autofix paused for tenant
 * @param {number|null} body.maxRetriesPerFailure  0..1000 or null (PR #34)
 * @param {object?} opts
 * @param {number?} opts.triggeredBy   operator user id for the audit event
 */
async function upsertConfig(projectIdRaw, body, opts = {}, deps = {}) {
  const db = deps.db || require('../db');
  const logger = deps.logger || require('../utils/logger');
  const projectId = Number(projectIdRaw);
  if (!Number.isFinite(projectId) || projectId <= 0) {
    throw new NotFoundError('project');
  }

  // Validate the project exists before we write — saves a useless
  // FK-violation error from pg with a clearer 404.
  const projectRes = await db.query(`SELECT 1 FROM projects WHERE id = $1`, [projectId]);
  if (projectRes.rows.length === 0) {
    throw new NotFoundError('project');
  }

  // The CHECK constraints (migrations 023, 025) enforce >= 0 when
  // non-null; zod at the route enforces upper bounds. RETURNING lets
  // us synthesize the response inline — saves the 2 extra queries a
  // follow-up getConfig() would issue (the FK on project_id already
  // guarantees the project exists once the INSERT succeeds).
  const dailyLimit = body.dailyLimit == null ? null : Math.floor(Number(body.dailyLimit));
  const maxRetriesPerFailure = body.maxRetriesPerFailure == null
    ? null : Math.floor(Number(body.maxRetriesPerFailure));
  const { enabled } = body;
  const r = await db.query(
    `INSERT INTO project_autofix_configs
       (project_id, daily_limit, enabled, max_retries_per_failure, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     ON CONFLICT (project_id) DO UPDATE
       SET daily_limit = EXCLUDED.daily_limit,
           enabled = EXCLUDED.enabled,
           max_retries_per_failure = EXCLUDED.max_retries_per_failure,
           updated_at = NOW()
     RETURNING daily_limit, enabled, max_retries_per_failure, created_at, updated_at`,
    [projectId, dailyLimit, enabled, maxRetriesPerFailure]
  );

  logger.warn({ event: 'autofix.project_config.updated',
    projectId, dailyLimit, enabled, maxRetriesPerFailure,
    triggeredBy: opts.triggeredBy || null },
    'autofix-project-config: per-project config updated');

  return shapeConfig(projectId, r.rows[0]);
}

module.exports = { getConfig, upsertConfig };
