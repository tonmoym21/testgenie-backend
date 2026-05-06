/**
 * Generic audit log service.
 *
 * Persists to the existing `team_audit_logs` table. The org_id column gates
 * visibility per organization; the schema is generic enough (action, target_type,
 * target_id, details JSONB, ip_address, user_agent) that all platform events
 * (auth, CRUD, executions, config changes, role changes) share it.
 */

const db = require('../db');
const logger = require('../utils/logger');

function getClientIp(req) {
  if (!req) return null;
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.ip || (req.connection && req.connection.remoteAddress) || null;
}

function getUserAgent(req) {
  if (!req || !req.headers) return null;
  return req.headers['user-agent'] || null;
}

/**
 * Log a single audit event. Best-effort — never throws.
 */
async function logEvent({
  orgId,
  actorId = null,
  action,
  targetType = null,
  targetId = null,
  details = {},
  status = 'success',
  req = null,
}) {
  if (!orgId || !action) return;
  try {
    await db.query(
      `INSERT INTO team_audit_logs
         (organization_id, actor_id, action, target_type, target_id, details, status, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        orgId,
        actorId,
        action,
        targetType,
        targetId == null ? null : String(targetId),
        JSON.stringify(details || {}),
        status,
        getClientIp(req),
        getUserAgent(req),
      ]
    );
  } catch (err) {
    logger.error({ err: err.message, orgId, action }, 'auditService.logEvent failed');
  }
}

/**
 * Query audit logs with filtering, search, and pagination.
 */
async function listEvents(orgId, options = {}) {
  const {
    action,
    actorId,
    status,
    search,
    dateFrom,
    dateTo,
    limit = 50,
    offset = 0,
  } = options;

  const params = [orgId];
  let idx = 2;
  let sql = `
    SELECT l.id, l.action, l.target_type, l.target_id, l.details,
           l.status, l.ip_address, l.user_agent, l.created_at,
           l.actor_id, u.email AS actor_email
      FROM team_audit_logs l
      LEFT JOIN users u ON l.actor_id = u.id
     WHERE l.organization_id = $1
  `;

  if (action) { sql += ` AND l.action = $${idx++}`; params.push(action); }
  if (actorId) { sql += ` AND l.actor_id = $${idx++}`; params.push(actorId); }
  if (status) { sql += ` AND l.status = $${idx++}`; params.push(status); }
  if (dateFrom) { sql += ` AND l.created_at >= $${idx++}`; params.push(dateFrom); }
  if (dateTo) { sql += ` AND l.created_at <= $${idx++}`; params.push(dateTo); }
  if (search) {
    sql += ` AND (l.action ILIKE $${idx} OR l.target_type ILIKE $${idx}
               OR COALESCE(l.target_id,'') ILIKE $${idx}
               OR COALESCE(u.email,'') ILIKE $${idx}
               OR l.details::text ILIKE $${idx})`;
    params.push(`%${search}%`);
    idx++;
  }

  // Count first
  const countSql = `SELECT COUNT(*)::int AS total FROM (${sql}) sub`;
  const countRes = await db.query(countSql, params);
  const total = countRes.rows[0]?.total ?? 0;

  sql += ` ORDER BY l.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
  params.push(Math.min(Number(limit) || 50, 1000));
  params.push(Number(offset) || 0);

  const result = await db.query(sql, params);
  return { logs: result.rows, total };
}

function csvEscape(v) {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : (typeof v === 'object' ? JSON.stringify(v) : String(v));
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function logsToCsv(rows) {
  const header = [
    'id', 'created_at', 'actor_email', 'actor_id', 'action',
    'target_type', 'target_id', 'status', 'ip_address', 'user_agent', 'details',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.id,
      r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      r.actor_email || '',
      r.actor_id || '',
      r.action,
      r.target_type || '',
      r.target_id || '',
      r.status || '',
      r.ip_address || '',
      r.user_agent || '',
      r.details,
    ].map(csvEscape).join(','));
  }
  return lines.join('\n');
}

module.exports = {
  logEvent,
  listEvents,
  logsToCsv,
  getClientIp,
  getUserAgent,
};
