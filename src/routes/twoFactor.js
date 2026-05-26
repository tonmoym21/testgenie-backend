// /api/auth/2fa/* — TOTP setup, confirm, disable, status.
//
// Login-flow integration ships in a follow-up. These endpoints only
// manage the secret + recovery code lifecycle so the frontend can
// expose an enable/disable UI right away. Until the login change
// lands, having totp_enabled_at set does NOT yet block login —
// it's purely informational on this endpoint set.

const { Router } = require('express');
const { z } = require('zod');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');
const { validate } = require('../middleware/validate');
const { ApiError, NotFoundError, UnauthorizedError, ConflictError } = require('../utils/apiError');
const totp = require('../services/totpService');
const logger = require('../utils/logger');

const router = Router();

const codeSchema = z.object({
  code: z.string().min(6).max(10), // 6 digits, or up to 10 with spaces/dashes
});
const disableSchema = z.object({
  password: z.string().min(1),
  // Either a current TOTP code OR a recovery code is acceptable proof
  // that the requester really has the second factor in hand.
  code: z.string().min(6).max(20),
});

// GET /api/auth/2fa/status — is 2FA enabled for the caller, and when?
router.get('/status', authenticate, async (req, res, next) => {
  try {
    const r = await db.query(
      'SELECT totp_enabled_at FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!r.rows.length) throw new NotFoundError('User');
    const enabledAt = r.rows[0].totp_enabled_at;
    res.json({
      enabled: enabledAt != null,
      enabledAt: enabledAt || null,
    });
  } catch (err) { next(err); }
});

// POST /api/auth/2fa/setup — start enrolment.
// Generates a fresh secret, stores it encrypted (un-enabled), returns
// the otpauth URL + base32 secret so the frontend can render a QR
// code and the user can scan it into their authenticator app.
//
// Idempotent — calling repeatedly before /confirm replaces the pending
// secret. Calling when 2FA is already enabled is a 409; the user must
// /disable first.
router.post('/setup', authenticate, authLimiter, async (req, res, next) => {
  try {
    const r = await db.query(
      'SELECT email, totp_enabled_at FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!r.rows.length) throw new NotFoundError('User');
    if (r.rows[0].totp_enabled_at != null) {
      throw new ConflictError('Two-factor auth is already enabled. Disable it first to re-enrol.');
    }
    const { secret, otpauthUrl } = totp.generateSecret(r.rows[0].email);
    const enc = totp.encryptSecret(secret);
    await db.query(
      'UPDATE users SET totp_secret_enc = $1, totp_enabled_at = NULL, updated_at = NOW() WHERE id = $2',
      [enc, req.user.id]
    );
    // Drop any previously-issued recovery codes — they'd be tied to the
    // old secret. Confirm regenerates them.
    await db.query('DELETE FROM user_recovery_codes WHERE user_id = $1', [req.user.id]);
    res.json({
      otpauthUrl,
      secret, // base32, shown to the user for manual entry as a fallback
    });
  } catch (err) { next(err); }
});

// POST /api/auth/2fa/confirm — user submits the first code from their
// authenticator. On success: mark enabled, issue + return recovery codes
// (ONCE — server only stores the hashes).
router.post('/confirm', authenticate, authLimiter, validate(codeSchema), async (req, res, next) => {
  try {
    const r = await db.query(
      'SELECT totp_secret_enc, totp_enabled_at FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!r.rows.length) throw new NotFoundError('User');
    if (r.rows[0].totp_enabled_at != null) {
      throw new ConflictError('Two-factor auth is already enabled.');
    }
    if (!r.rows[0].totp_secret_enc) {
      throw new ApiError(400, 'NO_PENDING_SETUP', 'No 2FA setup in progress. Call /setup first.');
    }
    const secret = totp.decryptSecret(r.rows[0].totp_secret_enc);
    if (!totp.verifyCode(secret, req.body.code)) {
      throw new ApiError(400, 'INVALID_CODE', 'That code is invalid. Check your authenticator app and try again.');
    }
    // Mint recovery codes, hash for storage, return plaintext ONCE.
    const codes = totp.generateRecoveryCodes();
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE users SET totp_enabled_at = NOW(), updated_at = NOW() WHERE id = $1',
        [req.user.id]
      );
      // Bulk insert hashed codes. Order doesn't matter; users redeem any.
      for (const code of codes) {
        await client.query(
          'INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1, $2)',
          [req.user.id, totp.hashRecoveryCode(code)]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    logger.info({ userId: req.user.id }, '2FA enabled');
    res.json({
      enabled: true,
      recoveryCodes: codes,
      message: 'Save these recovery codes somewhere safe. Each works once if you lose access to your authenticator. You won\'t see them again.',
    });
  } catch (err) { next(err); }
});

// POST /api/auth/2fa/disable — turn off 2FA. Requires password AND
// (TOTP code OR recovery code) as proof of possession. Wipes secret +
// remaining recovery codes.
router.post('/disable', authenticate, authLimiter, validate(disableSchema), async (req, res, next) => {
  try {
    const r = await db.query(
      'SELECT password_hash, totp_secret_enc, totp_enabled_at FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!r.rows.length) throw new NotFoundError('User');
    const user = r.rows[0];
    if (user.totp_enabled_at == null) {
      throw new ConflictError('Two-factor auth is not enabled.');
    }
    const passwordOk = await bcrypt.compare(req.body.password, user.password_hash);
    if (!passwordOk) throw new UnauthorizedError('Incorrect password');

    // Accept either a live TOTP code or a recovery code.
    const codeRaw = String(req.body.code || '');
    let secondFactorOk = false;
    if (/^\d{6}$/.test(codeRaw.replace(/\s/g, ''))) {
      const secret = totp.decryptSecret(user.totp_secret_enc);
      secondFactorOk = totp.verifyCode(secret, codeRaw);
    } else {
      const hash = totp.hashRecoveryCode(codeRaw);
      const rc = await db.query(
        `SELECT id FROM user_recovery_codes
          WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
        [req.user.id, hash]
      );
      if (rc.rows.length) {
        // Mark consumed even though we're about to delete everything —
        // belt-and-braces if the transaction below fails partway.
        await db.query('UPDATE user_recovery_codes SET used_at = NOW() WHERE id = $1', [rc.rows[0].id]);
        secondFactorOk = true;
      }
    }
    if (!secondFactorOk) {
      throw new ApiError(400, 'INVALID_CODE', 'That code or recovery code is invalid.');
    }

    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE users SET totp_secret_enc = NULL, totp_enabled_at = NULL, updated_at = NOW() WHERE id = $1',
        [req.user.id]
      );
      await client.query('DELETE FROM user_recovery_codes WHERE user_id = $1', [req.user.id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    logger.info({ userId: req.user.id }, '2FA disabled');
    res.json({ enabled: false });
  } catch (err) { next(err); }
});

module.exports = router;
