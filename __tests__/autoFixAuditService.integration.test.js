// Real-DB integration test for autoFixAuditService.
// Catches what mocks can't:
//   - INSERT against the real CHECK + FK constraints
//   - JSONB roundtrip (the payload param goes in as a string,
//     comes back as a parsed object)
//   - ON DELETE SET NULL behavior when the FK target is deleted
//   - The end-to-end reopen → audit wiring (PR #40 worked example)

const TEST_DB_URL = process.env.TEST_DB_URL || 'postgresql://postgres:postgres@localhost:5432/testforge_test';
process.env.DATABASE_URL = TEST_DB_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(64);
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-stub';
process.env.NODE_ENV = 'test';

const { Pool } = require('pg');
const db = require('../src/db');
const { recordEvent, listEvents } = require('../src/services/autoFixAuditService');
const { reopenFailure, markWontFix } = require('../src/services/autoFixFailuresService');

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
  const tag = `audit-it-${Date.now()}`;
  const u = await db.query(`INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [`${tag}@x.com`]);
  const p = await db.query(`INSERT INTO projects (user_id, name) VALUES ($1, $2) RETURNING id`, [u.rows[0].id, tag]);
  seed = { userId: u.rows[0].id, projectId: p.rows[0].id };
});

afterAll(async () => {
  if (db.pool && db.pool.end) await db.pool.end().catch(() => {});
});

beforeEach(async () => {
  if (!canConnect) return;
  // Clean only what we own.
  await db.query(`DELETE FROM autofix_audit_events WHERE project_id = $1`, [seed.projectId]);
  await db.query(
    `DELETE FROM fix_attempts WHERE test_failure_id IN (SELECT id FROM test_failures WHERE project_id = $1)`,
    [seed.projectId]
  );
  await db.query(`DELETE FROM test_failures WHERE project_id = $1`, [seed.projectId]);
});

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

async function seedFailure(fix_status, sig) {
  const r = await db.query(
    `INSERT INTO test_failures
       (project_id, failure_signature, sample_error_message, occurrence_count,
        first_seen_at, last_seen_at, fix_status, resolved_at)
     VALUES ($1, $2, 'err', 1, NOW(), NOW(), $3,
             CASE WHEN $3 = 'wont_fix' THEN NOW() ELSE NULL END)
     RETURNING id`,
    [seed.projectId, sig, fix_status]
  );
  return Number(r.rows[0].id);
}

describe('autoFixAuditService.recordEvent [real DB]', () => {
  it('persists a row with JSONB payload round-tripped through pg', async () => {
    if (!canConnect) { console.warn('[integration] skipping'); return; }
    const out = await recordEvent({
      eventType: 'autofix.failure.reopened',
      projectId: seed.projectId,
      failureId: null,
      triggeredBy: seed.userId,
      payload: { source: 'integration_test', nested: { count: 3 } },
    }, { db, logger: silentLogger });

    expect(out.id).toBeGreaterThan(0);

    const r = await db.query(
      `SELECT event_type, project_id, triggered_by, payload, occurred_at
         FROM autofix_audit_events WHERE id = $1`,
      [out.id]
    );
    expect(r.rows[0].event_type).toBe('autofix.failure.reopened');
    expect(r.rows[0].project_id).toBe(seed.projectId);
    // pg returns JSONB as a parsed object — the round-trip works.
    expect(r.rows[0].payload).toEqual({ source: 'integration_test', nested: { count: 3 } });
    expect(r.rows[0].occurred_at).toBeTruthy();
  });

  it('FK ON DELETE SET NULL preserves audit row when its subject is deleted', async () => {
    // The whole POINT of an audit log is to outlive the thing it
    // tracks. CASCADE would defeat that. Pinning the SET NULL
    // behavior end-to-end (vs. trusting the migration text).
    if (!canConnect) { console.warn('[integration] skipping'); return; }
    const failureId = await seedFailure('wont_fix', `audit-fk-${Date.now()}`);
    const evt = await recordEvent({
      eventType: 'autofix.failure.reopened',
      projectId: seed.projectId,
      failureId,
      triggeredBy: seed.userId,
    }, { db, logger: silentLogger });

    // Delete the failure — audit row should survive with NULL FK.
    await db.query(`DELETE FROM test_failures WHERE id = $1`, [failureId]);
    const r = await db.query(
      `SELECT failure_id, event_type FROM autofix_audit_events WHERE id = $1`,
      [evt.id]
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].failure_id).toBeNull();
    expect(r.rows[0].event_type).toBe('autofix.failure.reopened');
  });
});

describe('autoFixAuditService.listEvents [real DB]', () => {
  it('returns rows in occurred_at DESC order; respects project + event_type filter', async () => {
    if (!canConnect) { console.warn('[integration] skipping'); return; }
    await recordEvent({ eventType: 'autofix.failure.reopened', projectId: seed.projectId, triggeredBy: seed.userId },
      { db, logger: silentLogger });
    await recordEvent({ eventType: 'autofix.failure.wont_fix_manual', projectId: seed.projectId },
      { db, logger: silentLogger });
    await recordEvent({ eventType: 'autofix.failure.reopened', projectId: seed.projectId, triggeredBy: seed.userId },
      { db, logger: silentLogger });

    const out = await listEvents(
      { projectId: seed.projectId, eventType: 'autofix.failure.reopened' },
      { db }
    );
    expect(out.total).toBe(2);
    expect(out.items.every((r) => r.event_type === 'autofix.failure.reopened')).toBe(true);
    // Newest first — second insert (later occurred_at) before first.
    expect(new Date(out.items[0].occurred_at).getTime())
      .toBeGreaterThanOrEqual(new Date(out.items[1].occurred_at).getTime());
  });

  it('since filter excludes events before the cutoff', async () => {
    if (!canConnect) { console.warn('[integration] skipping'); return; }
    // Backdate one row, leave another at NOW. since=anchor between
    // them must yield exactly one match.
    const old = await recordEvent({ eventType: 'autofix.test', projectId: seed.projectId },
      { db, logger: silentLogger });
    await db.query(
      `UPDATE autofix_audit_events SET occurred_at = NOW() - INTERVAL '2 hours' WHERE id = $1`,
      [old.id]
    );
    await recordEvent({ eventType: 'autofix.test', projectId: seed.projectId },
      { db, logger: silentLogger });

    const anchor = new Date(Date.now() - 60 * 60 * 1000);  // 1h ago
    const out = await listEvents(
      { projectId: seed.projectId, since: anchor.toISOString() },
      { db }
    );
    expect(out.total).toBe(1);
  });
});

// End-to-end pinning of the PR #40 wired call site: when an operator
// reopens a wont_fix failure, the audit table acquires a matching row.
// This is the worked example — subsequent PRs that wire other call
// sites should add their own integration tests with the same shape.
describe('reopen wiring [real DB end-to-end]', () => {
  it('reopenFailure also persists an autofix.failure.reopened audit row', async () => {
    if (!canConnect) { console.warn('[integration] skipping'); return; }
    const failureId = await seedFailure('wont_fix', `audit-e2e-${Date.now()}`);

    await reopenFailure(failureId, { triggeredBy: seed.userId }, { db, logger: silentLogger });

    const out = await listEvents(
      { eventType: 'autofix.failure.reopened', failureId },
      { db }
    );
    expect(out.total).toBe(1);
    expect(out.items[0]).toMatchObject({
      event_type: 'autofix.failure.reopened',
      failure_id: failureId,
      triggered_by: seed.userId,
    });
    expect(out.items[0].payload).toEqual({ source: 'reopenFailure' });
  });
});

// PR #43 — same wiring shape as the reopen e2e above, for the
// markWontFix call site. This proves the audit substrate (PR #42)
// scales beyond one wire site without needing per-event-type
// special-casing.
describe('markWontFix wiring [real DB end-to-end]', () => {
  it('markWontFix also persists an autofix.failure.wont_fix_manual audit row', async () => {
    if (!canConnect) { console.warn('[integration] skipping'); return; }
    // Source state for markWontFix must be 'open' or 'fix_proposed'
    // (per PR #29). Using 'open' here.
    const failureId = await seedFailure('open', `audit-wf-${Date.now()}`);

    await markWontFix(failureId, { triggeredBy: seed.userId }, { db, logger: silentLogger });

    const out = await listEvents(
      { eventType: 'autofix.failure.wont_fix_manual', failureId },
      { db }
    );
    expect(out.total).toBe(1);
    expect(out.items[0]).toMatchObject({
      event_type: 'autofix.failure.wont_fix_manual',
      failure_id: failureId,
      triggered_by: seed.userId,
    });
    expect(out.items[0].payload).toEqual({ source: 'markWontFix' });
  });

  it('failed markWontFix (wrong source state) does NOT write an audit row', async () => {
    // Defensive: a CONFLICT-raising markWontFix throws before reaching
    // the audit call site. Pinning that — an audit row for a
    // rejected action would be misleading ("operator marked wont_fix"
    // when in fact they didn't, the system refused).
    if (!canConnect) { console.warn('[integration] skipping'); return; }
    const failureId = await seedFailure('resolved', `audit-wf-refuse-${Date.now()}`);

    await expect(markWontFix(failureId, {}, { db, logger: silentLogger }))
      .rejects.toMatchObject({ statusCode: 409 });

    const out = await listEvents(
      { eventType: 'autofix.failure.wont_fix_manual', failureId },
      { db }
    );
    expect(out.total).toBe(0);
  });
});
