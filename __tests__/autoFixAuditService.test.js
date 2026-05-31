// Unit tests for autoFixAuditService.{recordEvent, listEvents}.
// Real-DB behavior is in autoFixAuditService.integration.test.js.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://stub:stub@127.0.0.1/stub';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'x'.repeat(64);
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-stub';
process.env.NODE_ENV = 'test';

jest.mock('pg', () => {
  class Pool {
    constructor() {}
    query() { return Promise.resolve({ rows: [], rowCount: 0 }); }
    on() {}
    end() { return Promise.resolve(); }
  }
  return { Pool };
});

const { recordEvent, listEvents, DEFAULT_LIMIT, MAX_LIMIT } =
  require('../src/services/autoFixAuditService');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeDb(responses) {
  const calls = [];
  const query = jest.fn(async (sql, params) => {
    calls.push({ sql, params });
    for (const [matcher, response] of responses) {
      if (matcher.test(sql)) {
        if (response instanceof Error) throw response;
        return response;
      }
    }
    return { rows: [], rowCount: 0 };
  });
  return { query, calls };
}

describe('autoFixAuditService.recordEvent', () => {
  it('happy path: INSERTs with all fields, returns the new id', async () => {
    const db = makeDb([[/INSERT INTO autofix_audit_events/, { rows: [{ id: '42' }], rowCount: 1 }]]);

    const out = await recordEvent({
      eventType: 'autofix.failure.reopened',
      projectId: 7,
      failureId: 99,
      fixAttemptId: 200,
      triggeredBy: 1,
      payload: { source: 'reopenFailure' },
    }, { db, logger: silentLogger });

    expect(out).toEqual({ id: 42 });
    const call = db.calls[0];
    // params order [event_type, project_id, failure_id, fix_attempt_id, triggered_by, payload]
    expect(call.params[0]).toBe('autofix.failure.reopened');
    expect(call.params[1]).toBe(7);
    expect(call.params[2]).toBe(99);
    expect(call.params[3]).toBe(200);
    expect(call.params[4]).toBe(1);
    // Payload arrives as a stringified JSON ($6::jsonb).
    expect(JSON.parse(call.params[5])).toEqual({ source: 'reopenFailure' });
  });

  it('missing optional fields default to null (not undefined — pg rejects undefined)', async () => {
    const db = makeDb([[/INSERT INTO autofix_audit_events/, { rows: [{ id: '1' }], rowCount: 1 }]]);
    await recordEvent({ eventType: 'autofix.test' }, { db, logger: silentLogger });

    const call = db.calls[0];
    expect(call.params[1]).toBeNull();
    expect(call.params[2]).toBeNull();
    expect(call.params[3]).toBeNull();
    expect(call.params[4]).toBeNull();
    expect(call.params[5]).toBe('{}');
  });

  it('bad input (no eventType) logs error and returns null without writing', async () => {
    // Programming error path — we want to LOG loud (dev catches it)
    // but NEVER throw out at the caller (would crash the primary op).
    const db = makeDb([]);
    const errSpy = jest.fn();
    const out = await recordEvent({}, { db, logger: { ...silentLogger, error: errSpy } });
    expect(out).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
    // The bad-input event surfaces in the error logger.
    const call = errSpy.mock.calls[0];
    expect(call[0]).toMatchObject({ event: 'autofix.audit.bad_input' });
  });

  it('SWALLOWS db errors and returns null — audit failure must not bubble to caller', async () => {
    // The actual contract being pinned. If a recordEvent throws,
    // a reopen would 500 and the operator loses the action — far
    // worse than a missing audit row.
    const db = makeDb([[/INSERT INTO autofix_audit_events/, new Error('db unreachable')]]);
    const errSpy = jest.fn();

    const out = await recordEvent({
      eventType: 'autofix.failure.reopened',
      failureId: 99,
    }, { db, logger: { ...silentLogger, error: errSpy } });

    expect(out).toBeNull();
    // Operator-visible signal that the audit trail has a gap.
    const failedEvent = errSpy.mock.calls.find(
      (c) => c[0] && c[0].event === 'autofix.audit.write_failed'
    );
    expect(failedEvent).toBeTruthy();
    expect(failedEvent[0]).toMatchObject({
      eventType: 'autofix.failure.reopened',
      failureId: 99,
    });
  });
});

describe('autoFixAuditService.listEvents', () => {
  function fakeRow(overrides = {}) {
    return {
      id: 1, event_type: 'autofix.failure.reopened',
      project_id: 7, failure_id: 99, fix_attempt_id: null,
      triggered_by: 1, payload: {}, occurred_at: new Date(),
      ...overrides,
    };
  }

  it('happy path: COUNT + page run in parallel; returns {items, total, limit, offset}', async () => {
    const db = makeDb([
      [/SELECT COUNT/, { rows: [{ total: 3 }], rowCount: 1 }],
      [/ORDER BY occurred_at DESC/, { rows: [fakeRow(), fakeRow({ id: 2 })], rowCount: 2 }],
    ]);
    const out = await listEvents({}, { db });
    expect(out.total).toBe(3);
    expect(out.items).toHaveLength(2);
    expect(out.limit).toBe(DEFAULT_LIMIT);
    expect(out.offset).toBe(0);
  });

  it('eventType filter parameterizes', async () => {
    const db = makeDb([[/SELECT COUNT/, { rows: [{ total: 0 }], rowCount: 1 }],
                       [/ORDER BY/, { rows: [], rowCount: 0 }]]);
    await listEvents({ eventType: 'autofix.failure.reopened' }, { db });
    const pageCall = db.calls.find((c) => /ORDER BY/.test(c.sql));
    expect(pageCall.sql).toMatch(/WHERE event_type = \$1/);
    expect(pageCall.params[0]).toBe('autofix.failure.reopened');
  });

  it('projectId + failureId + since combine into one WHERE', async () => {
    const db = makeDb([[/SELECT COUNT/, { rows: [{ total: 0 }], rowCount: 1 }],
                       [/ORDER BY/, { rows: [], rowCount: 0 }]]);
    const since = new Date('2026-01-01T00:00:00Z');
    await listEvents({
      projectId: 7, failureId: 99, since: since.toISOString(),
    }, { db });
    const pageCall = db.calls.find((c) => /ORDER BY/.test(c.sql));
    expect(pageCall.sql).toMatch(/project_id = \$1/);
    expect(pageCall.sql).toMatch(/failure_id = \$2/);
    expect(pageCall.sql).toMatch(/occurred_at >= \$3/);
    // params = [projectId, failureId, since, limit, offset]
    expect(pageCall.params[0]).toBe(7);
    expect(pageCall.params[1]).toBe(99);
    expect(pageCall.params[2]).toEqual(since);
  });

  it('invalid since timestamp silently drops (gentle clamping)', async () => {
    const db = makeDb([[/SELECT COUNT/, { rows: [{ total: 0 }], rowCount: 1 }],
                       [/ORDER BY/, { rows: [], rowCount: 0 }]]);
    await listEvents({ since: 'not-a-date' }, { db });
    const pageCall = db.calls.find((c) => /ORDER BY/.test(c.sql));
    // occurred_at appears in SELECT + ORDER BY regardless; assert
    // it's not in the WHERE position. Easier: the params list
    // should not contain a Date when since was bogus.
    expect(pageCall.sql).not.toMatch(/occurred_at >=/);
  });

  it('limit clamps above MAX, below 1, and falls back on non-numeric', async () => {
    const db = makeDb([[/SELECT COUNT/, { rows: [{ total: 0 }], rowCount: 1 }],
                       [/ORDER BY/, { rows: [], rowCount: 0 }]]);
    expect((await listEvents({ limit: 99999 }, { db })).limit).toBe(MAX_LIMIT);
    expect((await listEvents({ limit: 0 }, { db })).limit).toBe(1);
    expect((await listEvents({ limit: 'abc' }, { db })).limit).toBe(DEFAULT_LIMIT);
  });

  it('offset clamps negative and non-numeric to 0', async () => {
    const db = makeDb([[/SELECT COUNT/, { rows: [{ total: 0 }], rowCount: 1 }],
                       [/ORDER BY/, { rows: [], rowCount: 0 }]]);
    expect((await listEvents({ offset: -5 }, { db })).offset).toBe(0);
    expect((await listEvents({ offset: 'whoops' }, { db })).offset).toBe(0);
  });
});
