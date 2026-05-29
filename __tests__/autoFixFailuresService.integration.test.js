// Real-DB integration test for autoFixFailuresService.
// Unit tests assert SQL fragments + clamping in isolation; this suite
// proves the dynamically-assembled WHERE clauses actually compile
// against Postgres and the LIMIT/OFFSET + ORDER BY produce the expected
// page slices.

const TEST_DB_URL = process.env.TEST_DB_URL || 'postgresql://postgres:postgres@localhost:5432/testforge_test';
process.env.DATABASE_URL = TEST_DB_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(64);
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-stub';
process.env.NODE_ENV = 'test';

const { Pool } = require('pg');
const db = require('../src/db');
const { listFailures, getFailureDetail, reopenFailure, markWontFix } = require('../src/services/autoFixFailuresService');

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
  const tag = `failures-it-${Date.now()}`;
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

// Seed N failures with a deterministic last_seen_at ordering so the
// page-order assertions are stable. signature gets the index so q-filter
// tests can pick a single row by substring.
async function seedFailures(count, { fix_status = 'open', sigPrefix = 'sig' } = {}) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const r = await db.query(
      `INSERT INTO test_failures
         (project_id, failure_signature, sample_error_message, occurrence_count,
          first_seen_at, last_seen_at, fix_status)
       VALUES ($1, $2, $3, 1,
               NOW() - ($4 || ' minutes')::INTERVAL,
               NOW() - ($4 || ' minutes')::INTERVAL,
               $5)
       RETURNING id`,
      [seed.projectId, `${sigPrefix}-${String(i).padStart(4, '0')}`, `err ${i}`,
       String(i + 1),  // i=0 is newest (1 minute ago), i=N-1 oldest
       fix_status]
    );
    // pg returns bigint as string by default; the service casts id::int
    // in its SELECT so out.items[].id is a JS number. Match that here
    // so toEqual comparisons don't trip on string-vs-number.
    ids.push(Number(r.rows[0].id));
  }
  return ids;
}

describe('autoFixFailuresService.listFailures [real DB]', () => {
  it('returns rows sorted by last_seen_at DESC, total reflects the filtered set', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    const ids = await seedFailures(5);
    // Add 2 in a different status so the filter test below has a denominator
    await seedFailures(2, { fix_status: 'resolved', sigPrefix: 'sigR' });

    const out = await listFailures({ projectId: seed.projectId }, { db });
    expect(out.total).toBe(7);
    expect(out.items).toHaveLength(7);
    // Newest first. seedFailures puts i=0 at the newest minute offset.
    // The 'resolved' batch was seeded AFTER, so its rows are the newest two.
    expect(out.items[0].fix_status).toBe('resolved');
    // Within the 'open' batch, ids[0] (i=0, newest in its batch) appears
    // before ids[4] (i=4, oldest in its batch).
    const openIds = out.items.filter((r) => r.fix_status === 'open').map((r) => r.id);
    expect(openIds[0]).toBe(ids[0]);
    expect(openIds[openIds.length - 1]).toBe(ids[ids.length - 1]);
  });

  it('status filter narrows both items and total', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    // Distinct sigPrefix per batch — the (project_id, failure_signature)
    // UNIQUE constraint disallows duplicate signatures within a project.
    await seedFailures(3, { sigPrefix: 'open' });
    await seedFailures(2, { sigPrefix: 'wont', fix_status: 'wont_fix' });

    const out = await listFailures({ projectId: seed.projectId, status: 'wont_fix' }, { db });
    expect(out.total).toBe(2);
    expect(out.items.every((r) => r.fix_status === 'wont_fix')).toBe(true);
  });

  it('q substring search matches signature OR error_message (case-insensitive)', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    await seedFailures(3, { sigPrefix: 'login' });
    await seedFailures(2, { sigPrefix: 'checkout' });

    // Match by signature
    const sigOut = await listFailures({ projectId: seed.projectId, q: 'CHECK' }, { db });
    expect(sigOut.total).toBe(2);

    // Match by sample_error_message (seedFailures sets it to "err N")
    const msgOut = await listFailures({ projectId: seed.projectId, q: 'err 1' }, { db });
    // "err 1" matches "err 1" rows only — in a 3-batch with i in [0,1,2],
    // index 1 has message "err 1". So 1 match in the login batch + (checkout
    // batch had i in [0,1] → message "err 1" also matches one). Total: 2.
    expect(msgOut.total).toBe(2);
  });

  it('limit + offset return the expected page slice', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    const ids = await seedFailures(5);

    const page1 = await listFailures({ projectId: seed.projectId, limit: 2, offset: 0 }, { db });
    expect(page1.items.map((r) => r.id)).toEqual([ids[0], ids[1]]);
    expect(page1.total).toBe(5);

    const page2 = await listFailures({ projectId: seed.projectId, limit: 2, offset: 2 }, { db });
    expect(page2.items.map((r) => r.id)).toEqual([ids[2], ids[3]]);

    const page3 = await listFailures({ projectId: seed.projectId, limit: 2, offset: 4 }, { db });
    expect(page3.items.map((r) => r.id)).toEqual([ids[4]]);
  });

  it('combined filters: status + q + projectId compile together', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    // Each batch needs a unique sigPrefix (project_id+signature unique).
    // We still want the q='login' substring to match across two batches,
    // so make BOTH login-bearing prefixes contain 'login' but differ
    // overall: 'login-open' vs 'login-wf'. q='login' substring-matches
    // both; 'other' batch doesn't match.
    await seedFailures(3, { sigPrefix: 'login-open', fix_status: 'open' });
    await seedFailures(2, { sigPrefix: 'login-wf', fix_status: 'wont_fix' });
    await seedFailures(2, { sigPrefix: 'other', fix_status: 'wont_fix' });

    const out = await listFailures(
      { projectId: seed.projectId, status: 'wont_fix', q: 'login' },
      { db }
    );
    expect(out.total).toBe(2);
    expect(out.items.every((r) => r.fix_status === 'wont_fix' && r.failure_signature.includes('login'))).toBe(true);
  });
});

describe('autoFixFailuresService.getFailureDetail [real DB]', () => {
  it('returns failure + attempts in chronological order', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    const [failureId] = await seedFailures(1);
    // Seed 3 attempts at distinct started_at offsets.
    for (let mins = 30; mins >= 10; mins -= 10) {
      await db.query(
        `INSERT INTO fix_attempts
           (test_failure_id, model_provider, model_name, branch_name, status, started_at)
         VALUES ($1, 'openai', 'gpt-4o', $2, 'verify_failed', NOW() - ($3 || ' minutes')::INTERVAL)`,
        [failureId, `b-${mins}`, String(mins)]
      );
    }

    const out = await getFailureDetail(failureId, { db });
    expect(out.id).toBe(failureId);
    expect(out.attempts).toHaveLength(3);
    // started_at ASC → oldest first → branch_name b-30 before b-10
    expect(out.attempts[0].branch_name).toBe('b-30');
    expect(out.attempts[2].branch_name).toBe('b-10');
  });

  it('throws NotFoundError (404) when the id does not exist', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    await expect(getFailureDetail(999999999, { db })).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  });
});

describe('autoFixFailuresService.reopenFailure [real DB]', () => {
  const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

  // Seed a single test_failures row with the given fix_status. Lets
  // each test exercise a different "source state" against real
  // Postgres (catches CHECK-constraint violations on fix_status that
  // the unit suite wouldn't see).
  async function seedFailureWithStatus(fix_status, { resolvedHoursAgo = null } = {}) {
    const r = await db.query(
      `INSERT INTO test_failures
         (project_id, failure_signature, sample_error_message, occurrence_count,
          first_seen_at, last_seen_at, fix_status)
       VALUES ($1, $2, 'err', 1, NOW(), NOW(), $3)
       RETURNING id`,
      [seed.projectId, `reopen-${fix_status}-${Date.now()}-${Math.random()}`, fix_status]
    );
    const id = Number(r.rows[0].id);
    if (resolvedHoursAgo != null) {
      await db.query(
        `UPDATE test_failures SET resolved_at = NOW() - ($1 || ' hours')::INTERVAL WHERE id = $2`,
        [String(resolvedHoursAgo), id]
      );
    }
    return id;
  }

  it('happy path: wont_fix -> open, clears resolved_at, returns refreshed detail', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    const id = await seedFailureWithStatus('wont_fix', { resolvedHoursAgo: 2 });

    const out = await reopenFailure(id, { triggeredBy: 99 }, { db, logger: silentLogger });

    expect(out.id).toBe(id);
    expect(out.fix_status).toBe('open');
    expect(out.resolved_at).toBeNull();
    // Empty attempts list (no fix_attempts seeded) — proves the
    // refreshed detail wiring works even on a row with no history.
    expect(out.attempts).toEqual([]);

    // Verify state actually persisted (not just the returned shape).
    const after = await db.query(`SELECT fix_status, resolved_at FROM test_failures WHERE id = $1`, [id]);
    expect(after.rows[0].fix_status).toBe('open');
    expect(after.rows[0].resolved_at).toBeNull();
  });

  it('409 when row is in open state — does NOT silently re-touch the row', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    const id = await seedFailureWithStatus('open');
    const before = await db.query(`SELECT last_seen_at FROM test_failures WHERE id = $1`, [id]);

    await expect(reopenFailure(id, {}, { db, logger: silentLogger })).rejects.toMatchObject({
      statusCode: 409,
    });

    // Critical: a refused reopen must leave the row untouched. The
    // 'open' guard isn't just about returning an error — a stray
    // UPDATE without a WHERE-clause guard would bump last_seen_at
    // and reset any pending cron-tick ordering.
    const after = await db.query(`SELECT last_seen_at FROM test_failures WHERE id = $1`, [id]);
    expect(after.rows[0].last_seen_at.toISOString())
      .toBe(before.rows[0].last_seen_at.toISOString());
  });

  it('409 when row is in fix_proposed state (race-with-in-flight-tick guard)', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    const id = await seedFailureWithStatus('fix_proposed');
    await expect(reopenFailure(id, {}, { db, logger: silentLogger })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
    });
  });

  it('409 when row is in resolved state (fix worked — refuse to reopen)', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    const id = await seedFailureWithStatus('resolved', { resolvedHoursAgo: 1 });
    await expect(reopenFailure(id, {}, { db, logger: silentLogger })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('404 when the id does not exist at all', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    await expect(reopenFailure(999999999, {}, { db, logger: silentLogger })).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  });
});

describe('autoFixFailuresService.markWontFix [real DB]', () => {
  const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

  // Same helper as the reopen suite — kept local because the
  // describe blocks can't share scope cleanly.
  async function seedFailureWithStatus(fix_status) {
    const r = await db.query(
      `INSERT INTO test_failures
         (project_id, failure_signature, sample_error_message, occurrence_count,
          first_seen_at, last_seen_at, fix_status)
       VALUES ($1, $2, 'err', 1, NOW(), NOW(), $3)
       RETURNING id`,
      [seed.projectId, `markwf-${fix_status}-${Date.now()}-${Math.random()}`, fix_status]
    );
    return Number(r.rows[0].id);
  }

  it('happy path from open: flips to wont_fix and sets resolved_at', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    const id = await seedFailureWithStatus('open');

    const out = await markWontFix(id, { triggeredBy: 99 }, { db, logger: silentLogger });

    expect(out.id).toBe(id);
    expect(out.fix_status).toBe('wont_fix');
    expect(out.resolved_at).toBeTruthy();

    // Verify persistence (not just returned shape).
    const after = await db.query(`SELECT fix_status, resolved_at FROM test_failures WHERE id = $1`, [id]);
    expect(after.rows[0].fix_status).toBe('wont_fix');
    expect(after.rows[0].resolved_at).toBeTruthy();
  });

  it('happy path from fix_proposed: also markable (unsticks crashed-tick rows)', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    const id = await seedFailureWithStatus('fix_proposed');
    const out = await markWontFix(id, {}, { db, logger: silentLogger });
    expect(out.fix_status).toBe('wont_fix');
  });

  it('409 when row is already wont_fix — does NOT bump resolved_at', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    const id = await seedFailureWithStatus('wont_fix');
    // Pin a known resolved_at so we can assert it's unchanged.
    await db.query(
      `UPDATE test_failures SET resolved_at = '2020-01-01T00:00:00Z' WHERE id = $1`,
      [id]
    );

    await expect(markWontFix(id, {}, { db, logger: silentLogger })).rejects.toMatchObject({
      statusCode: 409,
    });

    // Critical: refusing to mark must NOT touch the row. A stray UPDATE
    // without the IN-guard would advance resolved_at to NOW().
    const after = await db.query(`SELECT resolved_at FROM test_failures WHERE id = $1`, [id]);
    expect(after.rows[0].resolved_at.toISOString()).toBe('2020-01-01T00:00:00.000Z');
  });

  it('409 when row is resolved (refuses to reverse a real success)', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    const id = await seedFailureWithStatus('resolved');
    await expect(markWontFix(id, {}, { db, logger: silentLogger })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
    });
  });

  it('404 when the id does not exist at all', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    await expect(markWontFix(999999998, {}, { db, logger: silentLogger })).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  });

  it('wont_fix-then-reopen round-trips back to open with resolved_at cleared', async () => {
    // End-to-end check that PR #28 + this PR compose: mark → reopen
    // returns the row to a clean 'open' state. Validates that the
    // resolved_at-cleared invariant from reopenFailure works against
    // a row resolved_at-set by markWontFix.
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    const id = await seedFailureWithStatus('open');
    const marked = await markWontFix(id, {}, { db, logger: silentLogger });
    expect(marked.fix_status).toBe('wont_fix');
    expect(marked.resolved_at).toBeTruthy();

    const reopened = await reopenFailure(id, {}, { db, logger: silentLogger });
    expect(reopened.fix_status).toBe('open');
    expect(reopened.resolved_at).toBeNull();
  });
});
