// Real-DB integration test for autoFixMetricsService.getMetrics.
// The unit suite mocks db.query and asserts call shape — necessary but
// it cannot catch:
//   - PERCENTILE_CONT syntax / ordered-set aggregate gotchas
//   - the dynamic STATUS_FILTERS string actually compiling against
//     Postgres
//   - the FILTER (WHERE status = '...') clause matching real rows
//   - the cap-hits LEFT-merge with per-project rollup producing the
//     right project_id keys after pg returns them as integer not string
//
// This suite seeds a known-shape dataset and asserts the aggregate
// numbers come back correct.

const TEST_DB_URL = process.env.TEST_DB_URL || 'postgresql://postgres:postgres@localhost:5432/testforge_test';
process.env.DATABASE_URL = TEST_DB_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(64);
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-stub';
process.env.NODE_ENV = 'test';

const { Pool } = require('pg');
const db = require('../src/db');
const { getMetrics } = require('../src/services/autoFixMetricsService');

let canConnect = false;
let seed = null;

beforeAll(async () => {
  try {
    const probe = new Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 2000 });
    await probe.query('SELECT 1');
    await probe.end();
    canConnect = true;
  } catch (err) {
    console.warn(`\n[integration] skipping — could not reach ${TEST_DB_URL}: ${err.message}`);
    return;
  }

  // Two projects so the per-project breakdown has something to sort.
  const tag = `metrics-it-${Date.now()}`;
  const u = await db.query(`INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [`${tag}@x.com`]);
  const userId = u.rows[0].id;
  const p1 = await db.query(`INSERT INTO projects (user_id, name) VALUES ($1, $2) RETURNING id`, [userId, `${tag}-p1`]);
  const p2 = await db.query(`INSERT INTO projects (user_id, name) VALUES ($1, $2) RETURNING id`, [userId, `${tag}-p2`]);
  seed = { userId, projectAId: p1.rows[0].id, projectBId: p2.rows[0].id };
});

afterAll(async () => {
  if (db.pool && db.pool.end) await db.pool.end().catch(() => {});
});

beforeEach(async () => {
  if (!canConnect) return;
  // Clean only what we own — leave whatever the rest of the suite seeded alone.
  await db.query(
    `DELETE FROM fix_attempts WHERE test_failure_id IN (
       SELECT id FROM test_failures WHERE project_id = ANY($1::int[])
     )`,
    [[seed.projectAId, seed.projectBId]]
  );
  await db.query(
    `DELETE FROM test_failures WHERE project_id = ANY($1::int[])`,
    [[seed.projectAId, seed.projectBId]]
  );
});

// Seed a test_failures row with optional cap-hit state. Returns the
// failure id. INSERT always leaves resolved_at NULL; the cap-hit
// timestamp is set via a separate UPDATE so we can use a parameterized
// INTERVAL expression (you can't ?-substitute the body of an INTERVAL).
async function seedFailure({ projectId, signature, capHit = false, resolvedHoursAgo = 1 }) {
  const r = await db.query(
    `INSERT INTO test_failures
       (project_id, failure_signature, sample_error_message, occurrence_count,
        first_seen_at, last_seen_at, fix_status)
     VALUES ($1, $2, 'err', 1, NOW(), NOW(), $3)
     RETURNING id`,
    [projectId, signature, capHit ? 'wont_fix' : 'open']
  );
  if (capHit) {
    await db.query(
      `UPDATE test_failures SET resolved_at = NOW() - ($1 || ' hours')::INTERVAL WHERE id = $2`,
      [String(resolvedHoursAgo), r.rows[0].id]
    );
  }
  return r.rows[0].id;
}

// Insert a fix_attempts row with a controllable duration. startedHoursAgo
// is how far back in the window the row sits; durationSeconds controls
// the finished_at offset (null => in-flight, no finished_at).
async function seedAttempt({ failureId, status, startedHoursAgo = 1, durationSeconds = null }) {
  const finishedExpr = durationSeconds == null
    ? null
    : durationSeconds;
  return db.query(
    `INSERT INTO fix_attempts
       (test_failure_id, model_provider, model_name, branch_name, status,
        started_at, finished_at)
     VALUES ($1, 'openai', 'gpt-4o', $2, $3,
             NOW() - ($4 || ' hours')::INTERVAL,
             CASE WHEN $5::int IS NULL THEN NULL
                  ELSE NOW() - ($4 || ' hours')::INTERVAL + ($5 || ' seconds')::INTERVAL END)
     RETURNING id`,
    [failureId, `b-${Date.now()}-${Math.random()}`, status, String(startedHoursAgo), finishedExpr]
  );
}

describe('autoFixMetricsService.getMetrics [real DB]', () => {
  it('aggregates status breakdown, percentiles, and cap-hits across two projects', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }

    // Project A: 4 attempts (3 verified, 1 verify_failed). Durations: 1s, 2s, 3s, 4s.
    const fA = await seedFailure({ projectId: seed.projectAId, signature: 'sigA-001' });
    await seedAttempt({ failureId: fA, status: 'verified', durationSeconds: 1 });
    await seedAttempt({ failureId: fA, status: 'verified', durationSeconds: 2 });
    await seedAttempt({ failureId: fA, status: 'verified', durationSeconds: 3 });
    await seedAttempt({ failureId: fA, status: 'verify_failed', durationSeconds: 4 });

    // Project B: 2 attempts (1 failed, 1 in-flight). Plus a cap-hit on a
    // SECOND failure row to test cap-hit counting separately from attempt counting.
    const fB1 = await seedFailure({ projectId: seed.projectBId, signature: 'sigB-001' });
    await seedAttempt({ failureId: fB1, status: 'failed', durationSeconds: 1 });
    await seedAttempt({ failureId: fB1, status: 'proposed', durationSeconds: null }); // in-flight

    const fB2 = await seedFailure({ projectId: seed.projectBId, signature: 'sigB-002', capHit: true, resolvedHoursAgo: 2 });
    // The cap-hit also has prior verify_failed attempts that count toward
    // the rolling attempt total — mirror the real flow.
    await seedAttempt({ failureId: fB2, status: 'verify_failed', durationSeconds: 5 });

    // Project A also has a cap-hit (older, just inside window) to test
    // that the aggregator sums them.
    const fA2 = await seedFailure({ projectId: seed.projectAId, signature: 'sigA-002', capHit: true, resolvedHoursAgo: 3 });
    await seedAttempt({ failureId: fA2, status: 'verify_failed', durationSeconds: 10 });

    const out = await getMetrics({ windowHours: 24, topProjects: 200 }, { db });

    // We assert via byProject filtered to our two seeded projects rather
    // than against `global` — other tests in this suite may have left
    // attempts in the DB within the rolling window, and we want this
    // test to be isolated and repeatable. Per-project rows are exact.
    const projA = out.byProject.find((p) => p.projectId === seed.projectAId);
    const projB = out.byProject.find((p) => p.projectId === seed.projectBId);
    expect(projA).toBeTruthy();
    expect(projB).toBeTruthy();

    // Project A: 4 attempts on fA + 1 attempt on fA2 = 5
    expect(projA.attempts).toBe(5);
    expect(projA.statusBreakdown.verified).toBe(3);
    expect(projA.statusBreakdown.verify_failed).toBe(2);  // fA:1 + fA2:1
    expect(projA.capHits).toBe(1);  // fA2
    // verifySuccessRate for A = 3 / (3+2) = 0.6
    expect(projA.verifySuccessRate).toBeCloseTo(0.6, 3);

    // Project B: 2 on fB1 + 1 on fB2 = 3
    expect(projB.attempts).toBe(3);
    expect(projB.statusBreakdown.failed).toBe(1);
    expect(projB.statusBreakdown.proposed).toBe(1);
    expect(projB.statusBreakdown.verify_failed).toBe(1);  // fB2
    expect(projB.capHits).toBe(1);  // fB2
    // verifySuccessRate for B = 0 / (0+1) = 0
    expect(projB.verifySuccessRate).toBe(0);

    // Percentile sanity on the per-project rollup. Project A's
    // durations: [1000, 2000, 3000, 4000, 10000] sorted → p50 = 3000.
    // Bounds are loose to allow PERCENTILE_CONT's linear interpolation.
    expect(projA.durationMs.p50).toBeGreaterThanOrEqual(2500);
    expect(projA.durationMs.p50).toBeLessThanOrEqual(3500);
    expect(projA.durationMs.p95).toBeGreaterThanOrEqual(projA.durationMs.p50);

    // byProject is sorted by attempts DESC — A (5) must come before B (3)
    // among our owned rows.
    const indexA = out.byProject.findIndex((p) => p.projectId === seed.projectAId);
    const indexB = out.byProject.findIndex((p) => p.projectId === seed.projectBId);
    expect(indexA).toBeLessThan(indexB);
  });

  it('windowHours filters older attempts out of the rollup', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }

    const f = await seedFailure({ projectId: seed.projectAId, signature: 'sigW-001' });
    // 1 attempt INSIDE a 2h window
    await seedAttempt({ failureId: f, status: 'verified', startedHoursAgo: 0.5, durationSeconds: 1 });
    // 1 attempt OUTSIDE a 2h window
    await seedAttempt({ failureId: f, status: 'verified', startedHoursAgo: 5, durationSeconds: 1 });

    // global.attempts is across ALL projects in the DB — other suites
    // may have left rows, so we assert via byProject (filtered to our
    // seeded project) for an isolated, repeatable check.
    function ourProject(out) {
      return out.byProject.find((p) => p.projectId === seed.projectAId);
    }

    const out2h = await getMetrics({ windowHours: 2 }, { db });
    expect(ourProject(out2h).attempts).toBe(1);

    const out24h = await getMetrics({ windowHours: 24 }, { db });
    expect(ourProject(out24h).attempts).toBe(2);
  });

  it('empty window: returns zeros + null percentiles, never crashes', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    // beforeEach already cleared owned rows for these two projects.
    // Use windowHours=1 to dodge anything else the broader test DB has lying around.
    const out = await getMetrics({ windowHours: 1 }, { db });
    // We can't assert global.attempts === 0 because other suites may
    // have written fix_attempts within the last hour. Per-project for
    // OUR seeded projects is verifiable, though:
    const ours = out.byProject.filter((p) =>
      p.projectId === seed.projectAId || p.projectId === seed.projectBId
    );
    expect(ours).toEqual([]);  // nothing was seeded this test
  });
});
