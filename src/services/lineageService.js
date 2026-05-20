// src/services/lineageService.js
// Closed-loop lineage writes: after a Playwright run finishes, this module
// turns the JSON report into rows in playwright_run_results + test_failures.
// Phase 3 of the runner roadmap — empty fix_attempts is written by Phase 4.

const db = require('../db');
const logger = require('../utils/logger');
const { failureSignature, normalizeError } = require('../utils/failureSignature');

/**
 * Persist per-spec results and deduplicated failures for a finished run.
 *
 * @param {object} run          playwright_runs row (must have id, project_id)
 * @param {object|null} report  parsed Playwright JSON report (or null if missing)
 */
async function writeRunLineage(run, report) {
  if (!report || !Array.isArray(report.suites)) return { resultCount: 0, failureCount: 0 };

  const specs = flattenSpecs(report.suites);
  if (specs.length === 0) return { resultCount: 0, failureCount: 0 };

  // Map file_name -> { id, scenario_id, story_id } so each spec result can be
  // joined back to its source. One query per run is fine — these sets are small.
  const fileNames = [...new Set(specs.map((s) => s.file).filter(Boolean))];
  const testMap = await loadTestMap(run.project_id, fileNames);

  const rows = specs.map((s) => projectSpec(s, testMap));

  let resultCount = 0;
  let failureCount = 0;

  for (const r of rows) {
    try {
      await db.query(
        `INSERT INTO playwright_run_results
           (run_id, playwright_test_id, scenario_id, story_id,
            file_name, test_title, status, duration_ms, retry_attempt,
            error_message, error_stack, failure_signature,
            trace_path, video_path, screenshot_paths)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          run.id, r.testId, r.scenarioId, r.storyId,
          r.fileName, r.title, r.status, r.durationMs, r.retryAttempt,
          r.errorMessage, r.errorStack, r.signature,
          r.tracePath, r.videoPath, JSON.stringify(r.screenshotPaths || []),
        ]
      );
      resultCount++;

      if (r.signature) {
        await upsertFailure(run, r);
        failureCount++;
      }
    } catch (err) {
      logger.warn({ runId: run.id, file: r.fileName, err: err.message }, 'lineage: row insert failed');
    }
  }

  return { resultCount, failureCount };
}

// ---------------------------------------------------------------------------
// Report walking
// ---------------------------------------------------------------------------

/**
 * Playwright's JSON report is recursive: suites can contain suites and specs.
 * Each spec has tests (one per project) and each test has results (one per retry).
 * We collapse this into a flat list of {file, title, status, duration, ...},
 * keeping only the FINAL retry attempt per spec (matches the run's pass/fail count).
 */
function flattenSpecs(suites, parentFile) {
  const out = [];
  for (const suite of suites || []) {
    const file = suite.file || parentFile;
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        const results = test.results || [];
        if (results.length === 0) continue;
        // Last result = final attempt (Playwright orders them chronologically).
        const finalResult = results[results.length - 1];
        const errors = finalResult.errors || (finalResult.error ? [finalResult.error] : []);
        out.push({
          file: spec.file || file,
          title: spec.title || test.title || '',
          status: finalResult.status || 'failed',
          durationMs: finalResult.duration || 0,
          retryAttempt: finalResult.retry || 0,
          errorMessage: errors[0] ? truncate(errors[0].message || errors[0].value || '', 4000) : null,
          errorStack: errors[0] ? truncate(errors[0].stack || '', 8000) : null,
          attachments: finalResult.attachments || [],
        });
      }
    }
    if (Array.isArray(suite.suites)) {
      out.push(...flattenSpecs(suite.suites, file));
    }
  }
  return out;
}

function projectSpec(s, testMap) {
  const match = testMap.get(baseName(s.file)) || null;
  const isFailure = s.status === 'failed' || s.status === 'timedOut';
  return {
    fileName: baseName(s.file) || s.file || '',
    title: s.title,
    status: s.status,
    durationMs: s.durationMs,
    retryAttempt: s.retryAttempt,
    errorMessage: s.errorMessage,
    errorStack: s.errorStack,
    signature: isFailure ? failureSignature(s.errorMessage, s.errorStack) : null,
    testId: match ? match.id : null,
    scenarioId: match ? match.scenario_id : null,
    storyId: match ? match.story_id : null,
    tracePath: pickAttachment(s.attachments, /trace.*\.zip$/i),
    videoPath: pickAttachment(s.attachments, /\.(webm|mp4)$/i),
    screenshotPaths: pickAllAttachments(s.attachments, /\.(png|jpg|jpeg)$/i),
  };
}

function pickAttachment(attachments, regex) {
  const hit = (attachments || []).find((a) => a.path && regex.test(a.path));
  return hit ? hit.path : null;
}

function pickAllAttachments(attachments, regex) {
  return (attachments || []).filter((a) => a.path && regex.test(a.path)).map((a) => a.path);
}

// ---------------------------------------------------------------------------
// test_failures upsert
// ---------------------------------------------------------------------------

async function upsertFailure(run, r) {
  await db.query(
    `INSERT INTO test_failures
       (project_id, failure_signature, sample_error_message, sample_error_stack,
        last_test_id, last_run_id, last_story_id, occurrence_count,
        first_seen_at, last_seen_at, fix_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, NOW(), NOW(), 'open')
     ON CONFLICT (project_id, failure_signature) DO UPDATE SET
       occurrence_count = test_failures.occurrence_count + 1,
       last_seen_at     = NOW(),
       last_test_id     = COALESCE(EXCLUDED.last_test_id, test_failures.last_test_id),
       last_run_id      = EXCLUDED.last_run_id,
       last_story_id    = COALESCE(EXCLUDED.last_story_id, test_failures.last_story_id),
       fix_status       = CASE
         WHEN test_failures.fix_status = 'resolved' THEN 'open'
         ELSE test_failures.fix_status
       END`,
    [
      run.project_id,
      r.signature,
      truncate(r.errorMessage, 2000),
      truncate(r.errorStack, 4000),
      r.testId,
      run.id,
      r.storyId,
    ]
  );
}

// ---------------------------------------------------------------------------
// Lookups + utils
// ---------------------------------------------------------------------------

async function loadTestMap(projectId, fileNames) {
  const map = new Map();
  if (fileNames.length === 0) return map;
  const bases = fileNames.map(baseName).filter(Boolean);
  if (bases.length === 0) return map;
  const r = await db.query(
    `SELECT id, scenario_id, story_id, file_name
       FROM playwright_tests
      WHERE project_id = $1 AND file_name = ANY($2::text[])`,
    [projectId, bases]
  );
  for (const row of r.rows) map.set(row.file_name, row);
  return map;
}

function baseName(p) {
  if (!p) return '';
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1];
}

function truncate(s, max) {
  if (s == null) return null;
  return s.length > max ? s.slice(0, max) : s;
}

module.exports = { writeRunLineage };
