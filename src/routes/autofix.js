// src/routes/autofix.js
// Thin HTTP wrappers around the autofix services. Each handler returns the
// service result verbatim so the CLI, the cron, and the API see the same
// shape. Platform-admin gated — autofix can write files to the customer's
// repo and shell out to git, so it's not an end-user surface.
//
// Routes:
//   POST /api/autofix/propose   { failureId, model? }
//   POST /api/autofix/apply     { fixAttemptId, repo?, file?, base?, push?, openPr?, remote? }
//   POST /api/autofix/verify    { fixAttemptId, repo?, specPath?, base? }
//   POST /api/autofix/run       { batchSize? }     manual cron tick
//
// SECURITY: the `repo` field on /apply and /verify is an absolute filesystem
// path that the underlying services pass straight to `git` and `npx
// playwright` as the cwd. Caller trust matters — a malicious or buggy
// platform-admin could point apply at any directory the server process has
// write access to. The route is platform-admin gated (requirePlatformAdmin
// + auth) and rate-limited on /run, but DO NOT lower the auth gate without
// adding a whitelist (e.g. only accept project-id and look up the repo via
// project_repo_configs). When `repo` is omitted, the apply/verify services
// derive it from project_repo_configs by joining on fix_attempt_id — that's
// the safe default for any future end-user-reachable endpoint.
//
// All field validation is intentionally light: the services already throw
// descriptive Errors for missing pieces (e.g. "no project_repo_configs row").
// The 4xx mapping below catches the obvious shape errors so a malformed body
// doesn't produce a 500.

const { Router } = require('express');
const { z } = require('zod');
const { authenticate } = require('../middleware/auth');
const { requirePlatformAdmin } = require('../middleware/platformAdmin');
const { validate } = require('../middleware/validate');
const { adminMutationLimiter } = require('../middleware/rateLimiter');
const autoFixService = require('../services/autoFixService');
const autoFixApplyService = require('../services/autoFixApplyService');
const autoFixVerifyService = require('../services/autoFixVerifyService');
const autoFixCronService = require('../services/autoFixCronService');
const autoFixMetricsService = require('../services/autoFixMetricsService');
const autoFixFailuresService = require('../services/autoFixFailuresService');
const autoFixProjectConfigService = require('../services/autoFixProjectConfigService');

const router = Router();

router.use(authenticate, requirePlatformAdmin);

const proposeBody = z.object({
  failureId: z.number().int().positive(),
  model: z.string().min(1).max(120).optional(),
});

const applyBody = z.object({
  fixAttemptId: z.number().int().positive(),
  repo: z.string().min(1).optional(),
  file: z.string().min(1).optional(),
  base: z.string().min(1).optional(),
  push: z.boolean().optional(),
  openPr: z.boolean().optional(),
  remote: z.string().min(1).optional(),
  keepCheckout: z.boolean().optional(),
});

const verifyBody = z.object({
  fixAttemptId: z.number().int().positive(),
  repo: z.string().min(1).optional(),
  specPath: z.string().min(1).optional(),
  base: z.string().min(1).optional(),
});

const runBody = z.object({
  batchSize: z.number().int().positive().max(50).optional(),
});

router.post('/propose', validate(proposeBody), async (req, res, next) => {
  try {
    const { failureId, model } = req.body;
    const result = await autoFixService.proposeFix(failureId, {
      model: model || undefined,
      triggeredBy: req.user && req.user.id,
    });
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/apply', validate(applyBody), async (req, res, next) => {
  try {
    const result = await autoFixApplyService.applyFix(req.body);
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/verify', validate(verifyBody), async (req, res, next) => {
  try {
    const result = await autoFixVerifyService.verifyFix(req.body);
    res.json(result);
  } catch (err) { next(err); }
});

// Manual cron tick — runs propose+apply+verify for up to batchSize eligible
// rows right now. Force-enabled so it works even when AUTOFIX_CRON_ENABLED is
// unset (admin clicked the button on purpose). Rate-limited because a single
// click can fan out to multiple LLM + Playwright invocations; a stuck UI
// retry must not turn that into a billing incident.
router.post('/run', adminMutationLimiter, validate(runBody), async (req, res, next) => {
  try {
    const result = await autoFixCronService.tick({
      force: true,
      batchSize: req.body.batchSize,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// Rolling-window summary over fix_attempts + test_failures. JSON shape
// designed to be destination-agnostic — Datadog, Grafana, CloudWatch,
// or a curl-driven dashboard can all parse it. Query params:
//   windowHours    1..720 (default 24)
//   topProjects    1..200 (default 25) — caps byProject array length
// Out-of-range values are clamped to the legal range silently (rather
// than 400-ing) because this endpoint is meant to be hit by long-lived
// scrapers — a typo in a Datadog config shouldn't take the dashboard
// dark. Bad TYPES (non-numeric) fall through to the service's default.
router.get('/metrics', async (req, res, next) => {
  try {
    const result = await autoFixMetricsService.getMetrics({
      windowHours: req.query.windowHours,
      topProjects: req.query.topProjects,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// Paginated browse over test_failures for the failure-dashboard UI.
// Query params:
//   status        open | fix_proposed | fix_merged | wont_fix | resolved
//   projectId     scope to one project
//   q             substring match on signature OR sample_error_message
//   limit         1..200 (default 50)
//   offset        >= 0   (default 0)
// Returns { items, total, limit, offset }. Same gentle-clamping policy
// as /metrics — bad inputs don't 400, they fall back to defaults. status
// is silently ignored if not a legal enum value (typo in a saved filter
// shouldn't surface as a red error in the UI).
router.get('/failures', async (req, res, next) => {
  try {
    const result = await autoFixFailuresService.listFailures({
      status: req.query.status,
      projectId: req.query.projectId,
      q: req.query.q,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// Bulk variants — dashboard multi-select. Same auth + rate limit as
// the single-id endpoints. Per-id results are collected; one bad id
// does NOT fail the batch. Always returns 200; the response body's
// `failed` array tells the UI what went wrong per row.
//
// REGISTERED BEFORE /failures/:id/... routes because Express matches
// in declaration order. Otherwise `/failures/bulk/wont_fix` would
// hit `/failures/:id/wont_fix` with id="bulk".
const bulkFailuresBody = z.object({
  ids: z.array(z.number().int().positive())
    .min(1, 'ids must contain at least one id')
    .max(autoFixFailuresService.BULK_MAX_IDS,
      `ids must contain at most ${autoFixFailuresService.BULK_MAX_IDS} entries`),
});

router.post('/failures/bulk/wont_fix',
  adminMutationLimiter, validate(bulkFailuresBody),
  async (req, res, next) => {
    try {
      const result = await autoFixFailuresService.bulkMarkWontFix(req.body.ids, {
        triggeredBy: req.user && req.user.id,
      });
      res.json(result);
    } catch (err) { next(err); }
  });

router.post('/failures/bulk/reopen',
  adminMutationLimiter, validate(bulkFailuresBody),
  async (req, res, next) => {
    try {
      const result = await autoFixFailuresService.bulkReopen(req.body.ids, {
        triggeredBy: req.user && req.user.id,
      });
      res.json(result);
    } catch (err) { next(err); }
  });

// Full lineage for one failure: metadata + every fix_attempts row in
// chronological order. The :id segment is validated by the service
// (NaN/<=0 throws NotFoundError -> HTTP 404 via errorHandler).
router.get('/failures/:id', async (req, res, next) => {
  try {
    const result = await autoFixFailuresService.getFailureDetail(req.params.id);
    res.json(result);
  } catch (err) { next(err); }
});

// "Force retry" — flip a wont_fix failure back to open so the cron
// picks it up again next tick. Use case: operator believes a capped
// failure is actually fixable (edited the spec by hand, or the
// underlying app bug was patched). Rate-limited because a retry-loop
// in a flaky dashboard could otherwise fire dozens per second.
//   200 + refreshed detail on success
//   404 NOT_FOUND when the id doesn't exist
//   409 CONFLICT when the row isn't in wont_fix (prevents racing
//       in-flight ticks or accidentally reopening a resolved fix)
router.post('/failures/:id/reopen', adminMutationLimiter, async (req, res, next) => {
  try {
    const result = await autoFixFailuresService.reopenFailure(req.params.id, {
      triggeredBy: req.user && req.user.id,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// Pre-emptive wont_fix — inverse of /reopen. Operator-facing way to
// say "don't bother trying this failure" before the per-failure cap
// (PR #25) auto-fires. Saves 3 LLM calls + 3 verify spawns per row
// when ops already know it's a known-flaky / waiting-on-infra case.
//   200 + refreshed detail on success
//   404 NOT_FOUND when id missing
//   409 CONFLICT for non-markable source states (wont_fix, resolved,
//       fix_merged) — see service comment for the legal source set
router.post('/failures/:id/wont_fix', adminMutationLimiter, async (req, res, next) => {
  try {
    const result = await autoFixFailuresService.markWontFix(req.params.id, {
      triggeredBy: req.user && req.user.id,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// Heavy-payload diff view for a single fix_attempts row — returns
// patch_diff, new_code, prompt_excerpt (the columns GET /failures/:id
// deliberately excluded for payload size). Used by the dashboard
// "view diff" modal. Read-only, no rate limit.
//
// Nested under /failures/:failureId/ for two reasons:
//   1. RESTful — the data model is "attempts belong to a failure"
//   2. Defense in depth — a buggy frontend that links the wrong
//      failureId to an attempt gets a clean 404 instead of leaking
//      another failure's lineage into the wrong audit context.
router.get('/failures/:failureId/attempts/:attemptId/diff', async (req, res, next) => {
  try {
    const result = await autoFixFailuresService.getAttemptDiff(
      req.params.failureId,
      req.params.attemptId,
    );
    res.json(result);
  } catch (err) { next(err); }
});

// Per-project autofix configuration (PR #32). Today: just daily_limit
// (override of the global AUTOFIX_DAILY_LIMIT env). Schema designed
// to grow — when we add max_retries_per_failure or enabled toggle,
// they get extra fields on the same GET/PUT pair.
//
//   GET  /api/autofix/projects/:projectId/config
//        -> { projectId, dailyLimit, effectiveDailyLimit, envDailyLimit, createdAt, updatedAt }
//
//   PUT  /api/autofix/projects/:projectId/config
//        body: { dailyLimit: <int>=0 | null }
//        -> refreshed read shape

// PUT semantics — caller sends BOTH fields, replace not patch. The
// frontend GETs the current config first and submits the full body.
//
// dailyLimit upper bound is generous (2e9 ≈ INT max) — the DB CHECK
// enforces >= 0; the upper guard keeps pg from throwing "integer out
// of range" surfaced as 500. 0 is legal here too — it means "out of
// quota for this tenant" (NOT "autofix paused"; that's the enabled
// toggle below). Both 0 and `enabled=false` are legitimate states a
// dashboard might want to set independently.
const projectConfigBody = z.object({
  dailyLimit: z.union([
    z.number().int().min(0).max(2_000_000_000),
    z.null(),
  ]),
  enabled: z.boolean(),
  // PR #34 — per-project override for the per-failure retry cap.
  // Upper bound 1000 is operational sanity: anyone setting this
  // higher is misusing the cap. 0 is legal (= "disable cap, retry
  // forever"), matching the env-var semantics.
  maxRetriesPerFailure: z.union([
    z.number().int().min(0).max(1000),
    z.null(),
  ]),
});

router.get('/projects/:projectId/config', async (req, res, next) => {
  try {
    const result = await autoFixProjectConfigService.getConfig(req.params.projectId);
    res.json(result);
  } catch (err) { next(err); }
});

router.put(
  '/projects/:projectId/config',
  adminMutationLimiter,
  validate(projectConfigBody),
  async (req, res, next) => {
    try {
      const result = await autoFixProjectConfigService.upsertConfig(
        req.params.projectId,
        req.body,
        { triggeredBy: req.user && req.user.id },
      );
      res.json(result);
    } catch (err) { next(err); }
  }
);

module.exports = router;
