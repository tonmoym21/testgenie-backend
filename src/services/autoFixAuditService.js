// src/services/autoFixAuditService.js
// Persisted audit log for autofix operator + state-machine events
// (migration 026). Until PR #40 every `logger.warn({event:...})`
// went to stdout only — fine for grep, invisible to the dashboard.
// This service is the write seam: callers invoke recordEvent()
// alongside their existing logger.warn() so the event lands in
// both stdout (for incident triage) and the audit table (for
// "who did what when" UI).
//
// Sticking to "log + record" rather than "record then log via a
// listener" is deliberate: the existing logger calls have audit-
// relevant fields RIGHT THERE in code, easy to mirror with one
// extra recordEvent() call. A listener-based wiring would either
// re-parse the logger output (fragile) or require restructuring
// every call site to go through an event emitter (large blast
// radius).
//
// Write errors are SWALLOWED + logged but never thrown back at the
// caller. An audit-write failing is operationally meaningful (the
// trail has a gap) but it MUST NOT roll back the caller's primary
// operation. A reopen that succeeds but loses its audit entry is
// far better than a reopen that 500s because the audit table is
// momentarily slow.

const { NotFoundError } = require('../utils/apiError');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function clampLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)));
}

function clampOffset(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * Persist one audit event. Designed to be called from inside
 * existing service paths right next to their logger.warn() — the
 * fields mirror what the logger event already carries. Best-effort:
 * any DB error is logged + swallowed (see module header).
 *
 * @param {object} evt
 * @param {string} evt.eventType         e.g. 'autofix.failure.reopened'
 * @param {number?} evt.projectId
 * @param {number?} evt.failureId
 * @param {number?} evt.fixAttemptId
 * @param {number?} evt.triggeredBy      users.id for operator actions, null for cron
 * @param {object?} evt.payload          event-specific JSON blob
 * @param {object?} deps
 * @returns {Promise<{id: number} | null>}  id on success, null on swallowed error
 */
async function recordEvent(evt, deps = {}) {
  const db = deps.db || require('../db');
  const logger = deps.logger || require('../utils/logger');
  if (!evt || !evt.eventType || typeof evt.eventType !== 'string') {
    // Programming error — refuse silently in prod (don't crash the
    // calling op) but log loud so dev catches it.
    logger.error({ event: 'autofix.audit.bad_input', payload: evt },
      'autofix-audit: recordEvent called without eventType');
    return null;
  }
  try {
    const r = await db.query(
      `INSERT INTO autofix_audit_events
         (event_type, project_id, failure_id, fix_attempt_id, triggered_by, payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING id`,
      [
        evt.eventType,
        evt.projectId ?? null,
        evt.failureId ?? null,
        evt.fixAttemptId ?? null,
        evt.triggeredBy ?? null,
        JSON.stringify(evt.payload || {}),
      ]
    );
    return { id: Number(r.rows[0].id) };
  } catch (err) {
    // Don't propagate — audit write failure must not roll back the
    // primary op. Log at error so on-call sees the gap.
    logger.error({ event: 'autofix.audit.write_failed', err: err.message,
      eventType: evt.eventType, projectId: evt.projectId, failureId: evt.failureId },
      'autofix-audit: failed to persist event');
    return null;
  }
}

/**
 * Paginated read for the dashboard. Filters are AND-combined. Sort
 * is always occurred_at DESC (newest first) — there's no use case
 * for any other order on an audit log UI.
 *
 * @param {object?} filters
 * @param {string?} filters.eventType    exact match on event_type
 * @param {number?} filters.projectId
 * @param {number?} filters.failureId
 * @param {Date|string?} filters.since   ISO timestamp; only events at or after
 * @param {number?} filters.limit        1..500 (default 50)
 * @param {number?} filters.offset       >=0   (default 0)
 * @param {object?} deps
 */
async function listEvents(filters = {}, deps = {}) {
  const db = deps.db || require('../db');
  const limit = clampLimit(filters.limit);
  const offset = clampOffset(filters.offset);

  // Build WHERE incrementally so each filter is parameterized
  // (no SQL-injection surface) and absent filters produce no clause.
  // Same shape as autoFixFailuresService.listFailures.
  const where = [];
  const params = [];
  if (filters.eventType && typeof filters.eventType === 'string') {
    params.push(filters.eventType);
    where.push(`event_type = $${params.length}`);
  }
  if (filters.projectId != null) {
    const n = Number(filters.projectId);
    if (Number.isFinite(n)) {
      params.push(Math.floor(n));
      where.push(`project_id = $${params.length}`);
    }
  }
  if (filters.failureId != null) {
    const n = Number(filters.failureId);
    if (Number.isFinite(n)) {
      params.push(Math.floor(n));
      where.push(`failure_id = $${params.length}`);
    }
  }
  if (filters.since) {
    // Accept ISO string or Date; bad inputs silently drop (gentle
    // clamping policy consistent with the rest of the autofix API).
    const d = filters.since instanceof Date ? filters.since : new Date(filters.since);
    if (!isNaN(d.getTime())) {
      params.push(d);
      where.push(`occurred_at >= $${params.length}`);
    }
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // COUNT + page query in parallel — same pattern as listFailures.
  const countSql = `SELECT COUNT(*)::int AS total FROM autofix_audit_events ${whereSql}`;
  const pageParams = [...params, limit, offset];
  const limitIdx = pageParams.length - 1;
  const offsetIdx = pageParams.length;
  // pg returns BIGINT as string by default. Cast id / failure_id /
  // fix_attempt_id to int so the JSON shape stays consistent with the
  // other failure-side APIs (listFailures, getFailureDetail, etc.)
  // that already do this. Without it, JS callers comparing
  // event.failure_id === 99 silently fail.
  const pageSql = `
    SELECT id::int AS id, event_type, project_id,
           failure_id::int AS failure_id,
           fix_attempt_id::int AS fix_attempt_id,
           triggered_by, payload, occurred_at
      FROM autofix_audit_events
      ${whereSql}
      ORDER BY occurred_at DESC, id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
  `;

  const [countRes, pageRes] = await Promise.all([
    db.query(countSql, params),
    db.query(pageSql, pageParams),
  ]);

  return {
    items: pageRes.rows,
    total: countRes.rows[0] ? countRes.rows[0].total : 0,
    limit,
    offset,
  };
}

module.exports = {
  recordEvent,
  listEvents,
  // exported for tests
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
