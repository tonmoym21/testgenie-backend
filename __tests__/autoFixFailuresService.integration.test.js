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
const { listFailures, getFailureDetail } = require('../src/services/autoFixFailuresService');

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
