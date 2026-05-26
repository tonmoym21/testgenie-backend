// TOTP (RFC 6238) 2FA primitives — secret generation, code verification,
// at-rest encryption of secrets, and recovery code lifecycle.
//
// Storage model:
//   users.totp_secret_enc   AES-256-GCM(secret).  NULL = no 2FA on this user.
//   users.totp_enabled_at   Set by /2fa/confirm when the user submits a
//                           valid code for the first time. NULL between
//                           /2fa/setup and /2fa/confirm (provisional state).
//   user_recovery_codes     SHA-256 hashed, single-use, 10 per user.
//                           Re-issued whenever 2FA is re-enabled.
//
// Encryption key:
//   TOTP_ENCRYPTION_KEY env var, 32 raw bytes (hex or base64). Required
//   when any user has 2FA enabled; service throws clear error on first
//   use if missing. Deliberately separate from JWT_SECRET so JWT rotation
//   doesn't lock everyone out of 2FA-protected accounts.

const crypto = require('crypto');
const { authenticator } = require('otplib');

// 30s step, single-period drift tolerance — standard TOTP defaults.
// Window = 1 means the previous and next 30s buckets also validate;
// covers clock drift between server and authenticator app without
// widening replay risk.
authenticator.options = { window: 1 };

const RECOVERY_CODE_COUNT = 10;
const ISSUER = 'TestForge';

// ── Encryption ────────────────────────────────────────────────────────

/** Lazy-load the encryption key — module load shouldn't fail when 2FA
 *  isn't yet configured. First encrypt/decrypt call surfaces missing key
 *  with an actionable error. */
function _key() {
  const raw = process.env.TOTP_ENCRYPTION_KEY;
  if (!raw) {
    const err = new Error(
      'TOTP_ENCRYPTION_KEY is not set. Generate a 32-byte key and set it in env:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
    err.code = 'TOTP_KEY_MISSING';
    throw err;
  }
  // Accept hex (64 chars) or base64 (44 chars including padding).
  let buf;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) buf = Buffer.from(raw, 'hex');
  else buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error('TOTP_ENCRYPTION_KEY must decode to exactly 32 bytes (256 bits).');
  }
  return buf;
}

/** Encrypt a TOTP secret for storage. Output format:
 *    base64( iv | authTag | ciphertext )
 *  IV is 12 bytes (GCM standard). authTag is 16 bytes. */
function encryptSecret(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', _key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

/** Decrypt a stored TOTP secret. Throws on tampered/corrupt input. */
function decryptSecret(encoded) {
  const buf = Buffer.from(encoded, 'base64');
  if (buf.length < 28) throw new Error('Encrypted TOTP secret is malformed');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', _key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// ── TOTP secret + code ────────────────────────────────────────────────

/** Generate a fresh TOTP secret. Returns the raw base32 string + an
 *  otpauth:// URL the frontend renders as a QR code. */
function generateSecret(userEmail) {
  const secret = authenticator.generateSecret(); // base32
  const otpauthUrl = authenticator.keyuri(userEmail, ISSUER, secret);
  return { secret, otpauthUrl };
}

/** Verify a 6-digit code against a base32 secret. */
function verifyCode(secret, code) {
  if (!secret || !code || typeof code !== 'string') return false;
  // otplib expects digits only; strip spaces/dashes the user may have typed.
  const cleaned = code.replace(/\D/g, '');
  if (cleaned.length !== 6) return false;
  try {
    return authenticator.check(cleaned, secret);
  } catch {
    return false;
  }
}

// ── Recovery codes ────────────────────────────────────────────────────

/** Generate N readable recovery codes (e.g. 'xxxx-xxxx-xxxx'). */
function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    // 12 chars of crockford-ish base32 grouped as 4-4-4, avoiding visually
    // ambiguous characters (no 0/O, 1/I/L). Easy to read off a printout.
    const raw = crypto.randomBytes(9).toString('base64')
      .replace(/[+/=]/g, '')
      .replace(/[01OIL]/g, (c) => ({ '0': 'Z', '1': 'Y', 'O': 'X', 'I': 'W', 'L': 'V' }[c]))
      .slice(0, 12)
      .toUpperCase();
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`);
  }
  return codes;
}

/** Hash a recovery code for storage. Same scheme as refresh_tokens.token_hash. */
function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(code.replace(/\s|-/g, '').toUpperCase()).digest('hex');
}

module.exports = {
  generateSecret,
  verifyCode,
  encryptSecret,
  decryptSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  RECOVERY_CODE_COUNT,
};
