// Real-DB integration test for scripts/backfill-wont-fix.js.
// The unit suite mocks db.query and asserts call shape; this suite
// proves the GROUP BY + HAVING SELECT actually compiles AND filters
// correctly against Postgres, AND that the per-row UPDATE leaves
// non-eligible rows untouched.

const TEST_DB_URL = process.env.TEST_DB_URL || 'postgresql://postgres:postgres@localhost:5432/testforge_test';
process.env.DATABASE_URL = TEST_DB_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(64);
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-stub';
process.env.NODE_ENV = 'test';

const { Pool } = require('pg');
const db = require('../src/db');
const { runBackfill } = require('../scripts/backfill-wont-fix');

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
  const tag = `backfill-it-${Date.now()}`;
  const u = await db.query(`INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [`${tag}@x.com`]);
  const p = await db.query(`INSERT INTO projects (user_id, name) VALUES ($1, $2) RETURNING id`, [u.rows[0].id, tag]);
  seed = { userId: u.rows[0].id, projectId: p.rows[0].id };
});

afterAll(async () => {
  if (db.pool && db.pool.end) await db.pool.end().catch(() => {});
});

beforeEach(async () => {
  if (!canConnect) return;
  await db.query(
    `DELETE FROM fix_attempts WHERE test_failure_id IN (SELECT id FROM test_failures WHERE project_id = $1)`,
    [seed.projectId]
  );
  await db.query(`DELETE FROM test_failures WHERE project_id = $1`, [seed.projectId]);
});

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const noopReport = () => {};

// Seed a failure row with N pre-existing verify_failed attempts.
// Mirrors the shape a pre-PR-#25 deployment would have accumulated.
async function seedFailureWithAttempts({ verifyFailedCount, fix_status = 'open', sig }) {
  const f = await db.query(
    `INSERT INTO test_failures
       (project_id, failure_signature, sample_error_message, occurrence_count,
        first_seen_at, last_seen_at, fix_status)
     VALUES ($1, $2, 'err', 1, NOW(), NOW(), $3)
     RETURNING id`,
    [seed.projectId, sig, fix_status]
  );
  const failureId = Number(f.rows[0].id);
  for (let i = 0; i < verifyFailedCount; i++) {
    await db.query(
      `INSERT INTO fix_attempts
         (test_failure_id, model_provider, model_name, branch_name, status, started_at, finished_at)
       VALUES ($1, 'openai', 'gpt-4o', $2, 'verify_failed', NOW(), NOW())`,
      [failureId, `${sig}-b${i}`]
    );
  }
  return failureId;
}

describe('backfill-wont-fix [real DB]', () => {
  it('promotes only open rows with >= threshold verify_failed attempts; leaves others alone', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }

    // Three open rows of varying attempt counts: 1, 3, 5.
    // At threshold=3 only the second and third are eligible.
    const f1 = await seedFailureWithAttempts({ verifyFailedCount: 1, sig: 'bf-low' });
    const f3 = await seedFailureWithAttempts({ verifyFailedCount: 3, sig: 'bf-at-cap' });
    const f5 = await seedFailureWithAttempts({ verifyFailedCount: 5, sig: 'bf-above' });
    // Non-open row with many attempts — must NOT be touched (it
    // already settled, either to wont_fix or resolved).
    const fResolved = await seedFailureWithAttempts({
      verifyFailedCount: 7, fix_status: 'resolved', sig: 'bf-resolved'
    });

    const out = await runBackfill(
      { apply: true, threshold: 3, projectId: seed.projectId },
      { db, logger: silentLogger, report: noopReport }
    );

    expect(out.eligible).toBe(2);  // f3 + f5, NOT f1 (under cap), NOT fResolved (not open)
    expect(out.promoted).toBe(2);

    // f1 stays open — under the threshold.
    const r1 = await db.query(`SELECT fix_status FROM test_failures WHERE id = $1`, [f1]);
    expect(r1.rows[0].fix_status).toBe('open');

    // f3 and f5 flipped to wont_fix with resolved_at set.
    const r3 = await db.query(`SELECT fix_status, resolved_at FROM test_failures WHERE id = $1`, [f3]);
    expect(r3.rows[0].fix_status).toBe('wont_fix');
    expect(r3.rows[0].resolved_at).toBeTruthy();
    const r5 = await db.query(`SELECT fix_status FROM test_failures WHERE id = $1`, [f5]);
    expect(r5.rows[0].fix_status).toBe('wont_fix');

    // fResolved remains resolved — the WHERE fix_status='open' guard
    // is the actual contract being pinned here. A bug that dropped
    // it would silently overwrite real success state.
    const rR = await db.query(`SELECT fix_status FROM test_failures WHERE id = $1`, [fResolved]);
    expect(rR.rows[0].fix_status).toBe('resolved');
  });

  it('dry-run mode: identifies eligibility without writing a single row', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    const f = await seedFailureWithAttempts({ verifyFailedCount: 5, sig: 'bf-dryrun' });

    const out = await runBackfill(
      { apply: false, threshold: 3, projectId: seed.projectId },
      { db, logger: silentLogger, report: noopReport }
    );

    expect(out.eligible).toBe(1);
    expect(out.promoted).toBe(0);
    expect(out.dryRun).toBe(true);

    // The actual safety contract: dry-run must NOT mutate.
    const r = await db.query(`SELECT fix_status, resolved_at FROM test_failures WHERE id = $1`, [f]);
    expect(r.rows[0].fix_status).toBe('open');
    expect(r.rows[0].resolved_at).toBeNull();
  });

  it('idempotent: re-running after --apply does nothing (no qualifying rows left)', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    await seedFailureWithAttempts({ verifyFailedCount: 5, sig: 'bf-idem' });

    const first = await runBackfill(
      { apply: true, threshold: 3, projectId: seed.projectId },
      { db, logger: silentLogger, report: noopReport }
    );
    expect(first.promoted).toBe(1);

    const second = await runBackfill(
      { apply: true, threshold: 3, projectId: seed.projectId },
      { db, logger: silentLogger, report: noopReport }
    );
    expect(second.eligible).toBe(0);
    expect(second.promoted).toBe(0);
  });

  it('--threshold override: lower value catches more rows', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    await seedFailureWithAttempts({ verifyFailedCount: 2, sig: 'bf-thr-2' });
    await seedFailureWithAttempts({ verifyFailedCount: 4, sig: 'bf-thr-4' });

    const thr3 = await runBackfill(
      { apply: false, threshold: 3, projectId: seed.projectId },
      { db, logger: silentLogger, report: noopReport }
    );
    expect(thr3.eligible).toBe(1);  // only the one with 4 attempts

    const thr2 = await runBackfill(
      { apply: false, threshold: 2, projectId: seed.projectId },
      { db, logger: silentLogger, report: noopReport }
    );
    expect(thr2.eligible).toBe(2);  // both qualify
  });
});
