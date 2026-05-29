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

module.exports = router;
