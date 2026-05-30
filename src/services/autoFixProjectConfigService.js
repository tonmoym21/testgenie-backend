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
const { getEnvDailyLimit, countRecentAttempts } = require('./autoFixService');
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

/**
 * Dry-run preview of the autofix state for a project under a (possibly
 * hypothetical) config. The dashboard hits this as the operator edits
 * the config form, BEFORE they save — answers "if I drop the cap from
 * 10 to 5, how many failures will auto-promote on their next failed
 * verify?" and "with my new dailyLimit, how much quota do I have left
 * right now?"
 *
 * Optional overrides come from query params; absent fields fall back
 * to the currently-stored effective config. Pure read — no writes.
 *
 * Response shape:
 *   {
 *     projectId,
 *     previewedConfig: { dailyLimit, maxRetriesPerFailure, enabled },
 *     eligibleNow: int,             // how many failures the cron would
 *                                   //   pick up next tick under preview
 *     attemptsLast24h: int,         // current rolling-24h spend
 *     remainingQuotaToday: int|null,// previewedDailyLimit - attemptsLast24h,
 *                                   //   floored at 0; null when cap disabled (0)
 *     capHitRisk: int,              // open failures with verify_failed_count
 *                                   //   already >= (previewedMaxRetries - 1) —
 *                                   //   the NEXT verify_failed promotes them
 *   }
 *
 * @param {number} projectIdRaw
 * @param {object?} overrides       fields the form has changed but not saved
 * @param {number|null|undefined} overrides.dailyLimit
 * @param {number|null|undefined} overrides.maxRetriesPerFailure
 * @param {boolean|undefined}     overrides.enabled
 * @param {object?} deps
 */
async function previewConfig(projectIdRaw, overrides = {}, deps = {}) {
  const db = deps.db || require('../db');
  const projectId = Number(projectIdRaw);
  if (!Number.isFinite(projectId) || projectId <= 0) {
    throw new NotFoundError('project');
  }

  // Read the current stored config (also gives us 404 if the project
  // doesn't exist — same gate as getConfig). Then layer the overrides
  // on top.
  const stored = await getConfig(projectId, deps);
  const previewedConfig = {
    dailyLimit: overrides.dailyLimit !== undefined
      ? overrides.dailyLimit
      : stored.effectiveDailyLimit,
    maxRetriesPerFailure: overrides.maxRetriesPerFailure !== undefined
      ? overrides.maxRetriesPerFailure
      : stored.effectiveMaxRetriesPerFailure,
    enabled: overrides.enabled !== undefined
      ? overrides.enabled
      : stored.enabled,
  };

  // Three counts, run in parallel — none depends on the others. The
  // SQL is project-scoped throughout so the cost stays bounded by the
  // tenant's row count regardless of total DB size.
  //
  // eligibleNow respects the previewedConfig.enabled toggle: if the
  // preview turns autofix off, the count is 0 regardless of what's
  // open in the DB. Mirrors the cron's findEligibleFailures filter.
  //
  // capHitRisk's threshold uses (previewedMaxRetries - 1) because
  // recordVerifyFailed counts the JUST-flipped attempt — so a failure
  // currently at N-1 verify_failed attempts will be at N after its
  // next failed run, and N >= cap triggers wont_fix promotion. A
  // previewedMaxRetries of 0 disables the cap (env semantics), so
  // capHitRisk is meaningless — we report 0.
  const capThreshold = previewedConfig.maxRetriesPerFailure > 0
    ? previewedConfig.maxRetriesPerFailure - 1
    : null;

  const [eligibleNow, attemptsLast24h, capHitRisk] = await Promise.all([
    previewedConfig.enabled
      ? countEligibleFailures(db, projectId)
      : Promise.resolve(0),
    countRecentAttempts(projectId, { db }),
    capThreshold == null
      ? Promise.resolve(0)
      : countCapHitRisk(db, projectId, capThreshold),
  ]);

  // remainingQuotaToday: null when cap is disabled (0 = "no limit"
  // following the env semantics). Otherwise non-negative; a project
  // that's already over its (newly-lowered) cap reports 0, not a
  // negative number.
  const remainingQuotaToday = previewedConfig.dailyLimit === 0
    ? null
    : Math.max(0, previewedConfig.dailyLimit - attemptsLast24h);

  return {
    projectId,
    previewedConfig,
    eligibleNow,
    attemptsLast24h,
    remainingQuotaToday,
    capHitRisk,
  };
}

// How many test_failures would the cron pick up next tick for THIS
// project? Mirrors autoFixCronService.findEligibleFailures but
// project-scoped + count-only.
async function countEligibleFailures(db, projectId) {
  const r = await db.query(
    `SELECT COUNT(*)::int AS n
       FROM test_failures tf
       JOIN project_repo_configs prc ON prc.project_id = tf.project_id
      WHERE tf.project_id = $1
        AND tf.fix_status = 'open'
        AND tf.last_test_id IS NOT NULL`,
    [projectId]
  );
  return r.rows[0].n;
}

// Open failures whose existing verify_failed count is >= threshold.
// Used for the "if I save this lowered cap, how many failures auto-
// promote on the next bad run?" preview. HAVING because we're counting
// attempts PER failure, not rows globally.
async function countCapHitRisk(db, projectId, threshold) {
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT tf.id
         FROM test_failures tf
         JOIN fix_attempts fa ON fa.test_failure_id = tf.id
        WHERE tf.project_id = $1
          AND tf.fix_status = 'open'
          AND fa.status = 'verify_failed'
        GROUP BY tf.id
       HAVING COUNT(fa.id) >= $2
     ) at_risk`,
    [projectId, threshold]
  );
  return r.rows[0].n;
}

module.exports = { getConfig, upsertConfig, previewConfig };
