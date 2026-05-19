// src/services/repoConfigService.js
// Resolves a project's repo configuration (local checkout path, default
// branch, remote, GitHub repo, spec directory) for the auto-fix pipeline.
//
// The pipeline previously required the CALLER to pass `repo`/`base`/
// `remote` on every applyFix/verifyFix invocation. That worked for one
// hand-wired customer; it can't scale to multi-tenant deployments. The
// services now fall back to this lookup whenever the caller omits the
// override, so existing CLI flags still win but a cron only needs the
// fix_attempt_id.
//
// db is injectable so this module stays testable without Postgres.

const defaultDb = () => require('../db');

/**
 * @param {number} projectId
 * @param {object?} deps  { db }
 * @returns {Promise<RepoConfig|null>}
 */
async function getByProjectId(projectId, deps = {}) {
  const db = deps.db || defaultDb();
  const r = await db.query(
    `SELECT id, project_id, repo_path, base_branch, remote_name,
            github_repo, spec_dir, organization_id, created_at, updated_at
       FROM project_repo_configs
      WHERE project_id = $1
      LIMIT 1`,
    [projectId]
  );
  return r.rows[0] || null;
}

/**
 * Resolve a config by walking from a fix_attempt -> test_failure -> project.
 * This is the lookup the orchestrators do on every apply/verify.
 *
 * @param {number} fixAttemptId
 * @param {object?} deps
 * @returns {Promise<RepoConfig|null>}
 */
async function getByFixAttemptId(fixAttemptId, deps = {}) {
  const db = deps.db || defaultDb();
  const r = await db.query(
    `SELECT prc.id, prc.project_id, prc.repo_path, prc.base_branch,
            prc.remote_name, prc.github_repo, prc.spec_dir,
            prc.organization_id, prc.created_at, prc.updated_at
       FROM fix_attempts fa
       JOIN test_failures tf  ON tf.id  = fa.test_failure_id
       JOIN project_repo_configs prc ON prc.project_id = tf.project_id
      WHERE fa.id = $1
      LIMIT 1`,
    [fixAttemptId]
  );
  return r.rows[0] || null;
}

/**
 * Look up a config by 'owner/name'. Used by the GitHub webhook to scope
 * incoming merge events to the right project — even if a branch name
 * collides, only a PR on the matching github_repo counts.
 *
 * @param {string} githubRepo  'owner/name'
 * @param {object?} deps
 */
async function getByGithubRepo(githubRepo, deps = {}) {
  const db = deps.db || defaultDb();
  const r = await db.query(
    `SELECT id, project_id, repo_path, base_branch, remote_name,
            github_repo, spec_dir, organization_id, created_at, updated_at
       FROM project_repo_configs
      WHERE github_repo = $1
      LIMIT 1`,
    [githubRepo]
  );
  return r.rows[0] || null;
}

/**
 * Upsert a project's repo config. Idempotent by project_id (the table has
 * a UNIQUE constraint there). Pass only the fields you want to set; the
 * SQL COALESCEs against the existing row so partial updates work.
 *
 * @param {object} input
 * @param {number} input.projectId
 * @param {string} input.repoPath
 * @param {string?} input.baseBranch
 * @param {string?} input.remoteName
 * @param {string?} input.githubRepo
 * @param {string?} input.specDir
 * @param {number?} input.organizationId
 * @param {object?} deps
 */
async function upsert(input, deps = {}) {
  const db = deps.db || defaultDb();
  if (!input || !input.projectId) throw new Error('projectId is required');
  if (!input.repoPath) throw new Error('repoPath is required');

  const r = await db.query(
    `INSERT INTO project_repo_configs
       (project_id, repo_path, base_branch, remote_name, github_repo, spec_dir, organization_id)
     VALUES ($1, $2, COALESCE($3, 'main'), COALESCE($4, 'origin'), $5, COALESCE($6, 'tests'), $7)
     ON CONFLICT (project_id) DO UPDATE SET
       repo_path       = EXCLUDED.repo_path,
       base_branch     = COALESCE(EXCLUDED.base_branch, project_repo_configs.base_branch),
       remote_name     = COALESCE(EXCLUDED.remote_name, project_repo_configs.remote_name),
       github_repo     = COALESCE(EXCLUDED.github_repo, project_repo_configs.github_repo),
       spec_dir        = COALESCE(EXCLUDED.spec_dir, project_repo_configs.spec_dir),
       organization_id = COALESCE(EXCLUDED.organization_id, project_repo_configs.organization_id),
       updated_at      = NOW()
     RETURNING id, project_id, repo_path, base_branch, remote_name,
               github_repo, spec_dir, organization_id, created_at, updated_at`,
    [
      input.projectId,
      input.repoPath,
      input.baseBranch || null,
      input.remoteName || null,
      input.githubRepo || null,
      input.specDir || null,
      input.organizationId || null,
    ]
  );
  return r.rows[0];
}

module.exports = {
  getByProjectId,
  getByFixAttemptId,
  getByGithubRepo,
  upsert,
};
