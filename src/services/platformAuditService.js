const db = require('../db');
const logger = require('../utils/logger');

function getClientIp(req) {
  if (!req) return null;
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return (req.ip || (req.connection && req.connection.remoteAddress) || null);
}

async function log({ actorId, actorEmail, action, targetType, targetId, targetOrgId, details, req }) {
  try {
    await db.query(
      `INSERT INTO platform_audit_logs
         (actor_id, actor_email, action, target_type, target_id, target_org_id, details, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        actorId || null,
        actorEmail || null,
        action,
        targetType || null,
        targetId != null ? String(targetId) : null,
        targetOrgId || null,
        details || {},
        req ? getClientIp(req) : null,
        req && req.headers ? req.headers['user-agent'] || null : null,
      ]
    );
  } catch (err) {
    // Audit is best-effort — never break the action it's logging.
    logger.warn({ err: err.message, action }, 'platform audit log insert failed');
  }
}

module.exports = { log };
