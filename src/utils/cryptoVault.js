/**
 * Symmetric encryption helper for sensitive values stored in the DB
 * (e.g. third-party OAuth client secrets that the server itself needs to
 * decrypt at request time, so we can't use one-way hashing).
 *
 * AES-256-GCM with a 12-byte random IV per ciphertext. The key is derived
 * from `process.env.SECRETS_ENC_KEY` (preferred) or `JIRA_CONFIG_ENC_KEY`
 * (deprecated alias kept so the Jira rollout doesn't need a key rename) via
 * SHA-256 — so any sufficiently-long string works as a key, and rotating
 * the env var deterministically yields a new derived key.
 *
 * Stored format:  enc:v1:<iv_b64>:<authTag_b64>:<ciphertext_b64>
 *
 * If no key is configured the helper logs a warning and stores/returns the
 * value in plaintext. This preserves the previous behaviour for self-hosted
 * dev/test setups and makes the encryption opt-in via env var.
 */
const crypto = require('crypto');
const logger = require('./logger');

const ENC_PREFIX = 'enc:v1:';
let keyMissingWarned = false;

function getKey() {
  const raw = process.env.SECRETS_ENC_KEY || process.env.JIRA_CONFIG_ENC_KEY;
  if (!raw) return null;
  // Derive a fixed 32-byte key from any non-empty string. SHA-256 is fine
  // here because the input is a long-lived server secret, not a password —
  // the goal is shape, not slowing down attackers.
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

function warnOnce() {
  if (keyMissingWarned) return;
  keyMissingWarned = true;
  logger.warn(
    'SECRETS_ENC_KEY (or JIRA_CONFIG_ENC_KEY) is not set — sensitive ' +
    'values will be stored in plaintext. Set this env var to enable ' +
    'AES-256-GCM encryption at rest.'
  );
}

function encryptSecret(plaintext) {
  if (plaintext == null) return plaintext;
  const key = getKey();
  if (!key) {
    warnOnce();
    return plaintext;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

/**
 * Decrypt a value previously produced by encryptSecret. Pass-through for
 * legacy plaintext rows (no ENC_PREFIX). Returns null when an encrypted
 * value can't be decrypted (missing key / wrong key / tampered) — callers
 * treat that as "secret unavailable, can't proceed".
 */
function decryptSecret(stored) {
  if (stored == null) return stored;
  if (typeof stored !== 'string' || !stored.startsWith(ENC_PREFIX)) {
    return stored; // legacy plaintext row, pass through
  }
  const key = getKey();
  if (!key) {
    logger.error('Encrypted secret encountered but SECRETS_ENC_KEY is not set');
    return null;
  }
  try {
    const parts = stored.slice(ENC_PREFIX.length).split(':');
    if (parts.length !== 3) throw new Error('malformed ciphertext');
    const iv = Buffer.from(parts[0], 'base64');
    const tag = Buffer.from(parts[1], 'base64');
    const ct = Buffer.from(parts[2], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to decrypt secret — wrong key or tampered ciphertext');
    return null;
  }
}

function isEncryptionEnabled() {
  return !!getKey();
}

module.exports = { encryptSecret, decryptSecret, isEncryptionEnabled };
