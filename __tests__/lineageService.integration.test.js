// Real-DB integration test for lineageService.writeRunLineage.
//
// Mocked tests (lineageService.test.js) prove the SQL strings are issued
// in the right SHAPE. This suite proves they actually EXECUTE against a
// real Postgres on the migration set defined in migrations/. It catches
// the class of bug mocks can't: column-name typos, FK violations, broken
// ON CONFLICT clauses, JSONB vs JSON mismatches.
//
// Target DB: postgresql://postgres:postgres@localhost:5432/testforge_test
//   - Same local Postgres container the project uses for `docker compose
//     up dev`, but a SEPARATE database (testforge_test) so dev data isn't
//     touched and the test DB can be reset freely.
//   - To bootstrap from scratch:
//       docker exec <pg-container> psql -U postgres -c "CREATE DATABASE testforge_test;"
//       pg_dump --schema-only testgenie | psql -d testforge_test
//       psql -d testforge_test -f migrations/002_playwright_tests.sql
//       psql -d testforge_test -f migrations/003_automation_assets.sql
//       psql -d testforge_test -f migrations/012_runner_columns.sql
//       psql -d testforge_test -f migrations/013_closed_loop_lineage.sql
//
// The suite skips itself with a clear message if the DB isn't reachable —
// CI without a Postgres handy still passes.

const TEST_DB_URL = process.env.TEST_DB_URL || 'postgresql://postgres:postgres@localhost:5432/testforge_test';
process.env.DATABASE_URL = TEST_DB_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(64);
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-stub';
process.env.NODE_ENV = 'test';

const { Pool } = require('pg');
const lineageService = require('../src/services/lineageService');
const db = require('../src/db');

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

  // Seed: user -> project -> story -> scenario -> playwright_test -> playwright_run.
  // Use unique emails / names so re-running doesn't trip UNIQUE constraints.
  const tag = `lineage-it-${Date.now()}`;
  const u = await db.query(`INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [`${tag}@x.com`]);
  const userId = u.rows[0].id;
  const p = await db.query(`INSERT INTO projects (user_id, name) VALUES ($1, $2) RETURNING id`, [userId, tag]);
  const projectId = p.rows[0].id;
  const s = await db.query(
    `INSERT INTO stories (project_id, user_id, title, description) VALUES ($1, $2, 'login', 'login flow') RETURNING id`,
    [projectId, userId]
  );
  const storyId = s.rows[0].id;
  const sc = await db.query(
    `INSERT INTO scenarios (story_id, project_id, user_id, category, title) VALUES ($1, $2, $3, 'happy_path', 'login happy') RETURNING id`,
    [storyId, projectId, userId]
  );
  const scenarioId = sc.rows[0].id;
  const pt = await db.query(
    `INSERT INTO playwright_tests (project_id, scenario_id, story_id, test_name, file_name, code)
     VALUES ($1, $2, $3, 'login happy path', 'login.spec.ts', 'test(...);')
     RETURNING id`,
    [projectId, scenarioId, storyId]
  );
  const testId = pt.rows[0].id;
  // automation_assets requires source_test_ids; use the FK that's available.
  // automation_assets.story_id is UUID in the legacy schema while stories.id is
  // INTEGER — a pre-existing mismatch. Pass NULL and rely on source_test_ids.
  const aa = await db.query(
    `INSERT INTO automation_assets (project_id, created_by, name, slug, source_test_ids)
     VALUES ($1, $2, 'login asset', $3, $4::jsonb) RETURNING id`,
    [projectId, userId, `login-asset-${tag}`, JSON.stringify([testId])]
  );
  const assetId = aa.rows[0].id;
  const r = await db.query(
    `INSERT INTO playwright_runs (automation_asset_id, project_id, triggered_by, run_type, status, browser, started_at)
     VALUES ($1, $2, $3, 'single', 'running', 'chromium', NOW())
     RETURNING *`,
    [assetId, projectId, userId]
  );
  seed = { userId, projectId, storyId, scenarioId, testId, assetId, run: r.rows[0] };
});

afterAll(async () => {
  if (db.pool && db.pool.end) await db.pool.end().catch(() => {});
});

beforeEach(async () => {
  if (!canConnect) return;
  // Clean the lineage rows between cases without nuking seed.
  await db.query(`DELETE FROM playwright_run_results WHERE run_id = $1`, [seed.run.id]);
  await db.query(`DELETE FROM test_failures WHERE project_id = $1`, [seed.projectId]);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function reportFor(specs) {
  return {
    stats: { expected: specs.filter((s) => s.status === 'passed').length },
    suites: [{
      file: 'tests/login.spec.ts',
      specs: specs.map((s) => ({
        title: s.title,
        file: s.file || 'tests/login.spec.ts',
        tests: [{
          title: s.title,
          results: [{
            status: s.status,
            duration: s.duration || 100,
            retry: 0,
            errors: s.error ? [{ message: s.error, stack: s.stack || '' }] : [],
            attachments: [],
          }],
        }],
      })),
    }],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('lineageService.writeRunLineage [real DB]', () => {
  it('inserts per-spec rows with resolved story_id / scenario_id from file_name', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    const report = reportFor([
      { title: 'logs in', status: 'passed' },
      { title: 'logs out', status: 'passed' },
    ]);

    const out = await lineageService.writeRunLineage(seed.run, report);
    expect(out).toEqual({ resultCount: 2, failureCount: 0 });

    const rows = await db.query(
      `SELECT status, story_id, scenario_id, playwright_test_id, file_name
         FROM playwright_run_results WHERE run_id = $1 ORDER BY id`,
      [seed.run.id]
    );
    expect(rows.rows).toHaveLength(2);
    for (const r of rows.rows) {
      expect(r.status).toBe('passed');
      expect(r.story_id).toBe(seed.storyId);
      expect(r.scenario_id).toBe(seed.scenarioId);
      expect(r.playwright_test_id).toBe(seed.testId);
      expect(r.file_name).toBe('login.spec.ts');
    }
  });

  it('upserts a test_failures row with a non-null signature; second occurrence increments the counter', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    const error = 'Element not found: #login';
    const stack = 'at /app/tests/login.spec.ts:5:7';

    // First failing run
    await lineageService.writeRunLineage(seed.run, reportFor([{ title: 'A', status: 'failed', error, stack }]));

    let row = await db.query(
      `SELECT * FROM test_failures WHERE project_id = $1`, [seed.projectId]
    );
    expect(row.rows).toHaveLength(1);
    const first = row.rows[0];
    expect(first.failure_signature).toMatch(/^[0-9a-f]{16}$/);
    expect(first.occurrence_count).toBe(1);
    expect(first.fix_status).toBe('open');
    expect(first.last_test_id).toBe(seed.testId);

    // Same signature, second occurrence (different spec title, same error -> same hash).
    // ON CONFLICT (project_id, failure_signature) must fire.
    await lineageService.writeRunLineage(seed.run, reportFor([{ title: 'B', status: 'failed', error, stack }]));

    row = await db.query(
      `SELECT id, occurrence_count, first_seen_at, last_seen_at
         FROM test_failures WHERE project_id = $1`,
      [seed.projectId]
    );
    expect(row.rows).toHaveLength(1);                 // still ONE row — dedup works
    expect(row.rows[0].id).toBe(first.id);            // same surrogate key
    expect(row.rows[0].occurrence_count).toBe(2);     // counter advanced
    expect(row.rows[0].first_seen_at.getTime()).toBeLessThanOrEqual(row.rows[0].last_seen_at.getTime());
  });

  it('two distinct error signatures stay as separate failures', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    await lineageService.writeRunLineage(seed.run, reportFor([
      { title: 'A', status: 'failed', error: 'Element not found: #login', stack: 'at /t.ts:1:1' },
      { title: 'B', status: 'failed', error: 'Network request failed', stack: 'at /t.ts:1:1' },
    ]));

    const r = await db.query(
      `SELECT failure_signature, occurrence_count FROM test_failures WHERE project_id = $1 ORDER BY id`,
      [seed.projectId]
    );
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0].failure_signature).not.toBe(r.rows[1].failure_signature);
    expect(r.rows[0].occurrence_count).toBe(1);
    expect(r.rows[1].occurrence_count).toBe(1);
  });
});
