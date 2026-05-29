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

/**
 * Read the per-project autofix config plus the env default and the
 * effective resolved value. The 404 here is "project doesn't exist,"
 * not "no config row" — a missing config row is a legitimate state
 * meaning "use env default."
 *
 * Response shape:
 *   {
 *     projectId,
 *     dailyLimit: <int|null>,   the raw column (null = no override)
 *     effectiveDailyLimit: int, what the autofix loop will actually use
 *     envDailyLimit: int,       the env-level fallback (so the UI can
 *                               render "using env default" vs override)
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
    `SELECT daily_limit, created_at, updated_at
       FROM project_autofix_configs
      WHERE project_id = $1`,
    [projectId]
  );
  const cfg = cfgRes.rows[0] || null;
  const envDefault = getEnvDailyLimit();
  const dailyLimit = cfg ? cfg.daily_limit : null;

  return {
    projectId,
    dailyLimit,
    effectiveDailyLimit: dailyLimit != null ? dailyLimit : envDefault,
    envDailyLimit: envDefault,
    createdAt: cfg ? cfg.created_at : null,
    updatedAt: cfg ? cfg.updated_at : null,
  };
}

/**
 * Upsert the config row. Explicit null in body.dailyLimit clears the
 * override (revert to env default); omitted is rejected at the route
 * level via zod so this function doesn't need to distinguish.
 *
 * @param {number} projectIdRaw
 * @param {object} body
 * @param {number|null} body.dailyLimit  0..2_000_000_000 or null
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

  // The CHECK constraint in migration 023 enforces daily_limit >= 0
  // when non-null; zod at the route enforces the upper bound. The
  // INSERT…ON CONFLICT keeps the operation single-statement and atomic.
  const dailyLimit = body.dailyLimit == null ? null : Math.floor(Number(body.dailyLimit));
  await db.query(
    `INSERT INTO project_autofix_configs (project_id, daily_limit, created_at, updated_at)
     VALUES ($1, $2, NOW(), NOW())
     ON CONFLICT (project_id) DO UPDATE
       SET daily_limit = EXCLUDED.daily_limit,
           updated_at = NOW()`,
    [projectId, dailyLimit]
  );

  logger.warn({ event: 'autofix.project_config.updated',
    projectId, dailyLimit, triggeredBy: opts.triggeredBy || null },
    'autofix-project-config: per-project daily_limit updated');

  // Return the refreshed read shape so the UI doesn't need a follow-up GET.
  return getConfig(projectId, deps);
}

module.exports = { getConfig, upsertConfig };
