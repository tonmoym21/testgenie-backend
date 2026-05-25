// Background cleanup for abandoned public signups.
//
// The public signup flow (authService.register, kind='pending') leaves:
//   - a row in users with email_verified_at IS NULL
//   - a row in organizations with verified_at IS NULL
//   - a row in organization_members (owner role)
//   - a row in email_verification_tokens
//
// If the user never clicks the verification link, those rows accumulate
// forever. Worse, they squat on the email + display name and the
// org+user+token rows pile up over months of abandoned signups.
//
// The janitor sweeps pending rows older than PENDING_TTL_DAYS:
//   1. Find users with email_verified_at IS NULL AND created_at < cutoff
//   2. For each, delete the user — ON DELETE CASCADE on
//      email_verification_tokens.user_id + organization_members.user_id
//      handles the dependents. The org row is left for the second pass
//      below since multiple users could (in pathological cases) share
//      an org id.
//   3. Sweep orgs with verified_at IS NULL AND created_at < cutoff that
//      have zero remaining members. Deletes the orphan org.
//
// Run model:
//   - On startup (small delay so DB pool is up)
//   - Then every 24h via setInterval. Render's free tier has no cron.
//
// Safe to call repeatedly. Idempotent. Logs a summary; failures are
// caught + logged but never crash the process.

const db = require('../db');
const logger = require('../utils/logger');

const PENDING_TTL_DAYS = 7;
const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const STARTUP_DELAY_MS = 30 * 1000;      // 30s after boot

async function sweepOnce() {
  const startedAt = Date.now();
  let deletedUsers = 0;
  let deletedOrgs = 0;
  try {
    const userResult = await db.query(
      `DELETE FROM users
        WHERE email_verified_at IS NULL
          AND created_at < NOW() - INTERVAL '${PENDING_TTL_DAYS} days'
          AND is_platform_admin = false
        RETURNING id`
    );
    deletedUsers = userResult.rowCount || 0;

    // Sweep orphan pending orgs — no members remaining AND never verified.
    // The check on organization_members is what makes this safe: we don't
    // touch any org that still has a real owner (e.g. an org created by an
    // earlier verified user that happens to also have unverified invitees).
    const orgResult = await db.query(
      `DELETE FROM organizations o
        WHERE o.verified_at IS NULL
          AND o.created_via = 'signup'
          AND o.created_at < NOW() - INTERVAL '${PENDING_TTL_DAYS} days'
          AND NOT EXISTS (
            SELECT 1 FROM organization_members m WHERE m.organization_id = o.id
          )
        RETURNING id`
    );
    deletedOrgs = orgResult.rowCount || 0;

    if (deletedUsers > 0 || deletedOrgs > 0) {
      logger.info(
        { deletedUsers, deletedOrgs, durationMs: Date.now() - startedAt },
        '[signup-janitor] swept abandoned pending signups'
      );
    } else {
      logger.debug(
        { durationMs: Date.now() - startedAt },
        '[signup-janitor] nothing to sweep'
      );
    }
    return { deletedUsers, deletedOrgs };
  } catch (err) {
    logger.error({ err: err.message }, '[signup-janitor] sweep failed');
    return { deletedUsers, deletedOrgs, error: err.message };
  }
}

let _intervalHandle = null;
let _startupHandle = null;

function start() {
  if (_intervalHandle) return; // already started
  // Delayed first sweep so we don't race with DB pool init.
  _startupHandle = setTimeout(() => {
    sweepOnce().catch((err) =>
      logger.error({ err: err.message }, '[signup-janitor] startup sweep crashed')
    );
  }, STARTUP_DELAY_MS);
  _intervalHandle = setInterval(() => {
    sweepOnce().catch((err) =>
      logger.error({ err: err.message }, '[signup-janitor] interval sweep crashed')
    );
  }, INTERVAL_MS);
  // Don't keep the event loop alive for the timer — production servers
  // run as long-lived processes anyway, and unref() lets tests exit
  // cleanly without explicit teardown.
  if (_intervalHandle.unref) _intervalHandle.unref();
  if (_startupHandle.unref) _startupHandle.unref();
  logger.info({ ttlDays: PENDING_TTL_DAYS, intervalMs: INTERVAL_MS }, '[signup-janitor] started');
}

function stop() {
  if (_startupHandle) { clearTimeout(_startupHandle); _startupHandle = null; }
  if (_intervalHandle) { clearInterval(_intervalHandle); _intervalHandle = null; }
}

module.exports = { start, stop, sweepOnce, PENDING_TTL_DAYS };
