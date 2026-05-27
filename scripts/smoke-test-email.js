#!/usr/bin/env node
/**
 * Send a single test email through the configured transactionalEmail
 * pipeline. Use to verify Resend (or any future provider) is wired up
 * correctly without going through the full signup flow.
 *
 * Usage:
 *   node scripts/smoke-test-email.js <recipient@example.com>
 *
 * What it does:
 *   1. Reads EMAIL_PROVIDER + RESEND_API_KEY + EMAIL_FROM from .env
 *   2. Calls transactionalEmail.sendVerificationEmail with a fake
 *      company name + dummy token, so the recipient sees a realistic
 *      preview of what production signups will look like
 *   3. Prints the provider response (success id, or error reason)
 *
 * Exits 0 on send success, non-zero on any provider failure or
 * misconfiguration. Suitable for CI smoke tests once a verified
 * sender domain is set up — until then run it manually after rotating
 * the Resend key.
 *
 * Failure modes worth knowing:
 *   - { reason: 'not_configured' }   → RESEND_API_KEY is missing/empty
 *   - { reason: 'provider_error' }   → Resend rejected (bad key, sender
 *                                      not verified, recipient rate-limited)
 *   - { reason: 'exception' }        → network error / SDK threw
 */

require('dotenv').config();

async function main() {
  const recipient = process.argv[2];
  if (!recipient || process.argv.includes('-h') || process.argv.includes('--help')) {
    console.log('Usage: node scripts/smoke-test-email.js <recipient@example.com>');
    process.exit(recipient ? 0 : 1);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    console.error(`Invalid email: ${recipient}`);
    process.exit(1);
  }

  // Late-require so any .env-driven side effects (logger config, etc.) run
  // after dotenv has populated process.env.
  const transactionalEmail = require('../src/services/transactionalEmail');
  const { PROVIDER, EMAIL_FROM, APP_BASE_URL } = transactionalEmail._internal;

  console.log('[smoke-test-email] config:');
  console.log(`  EMAIL_PROVIDER  = ${PROVIDER}`);
  console.log(`  EMAIL_FROM      = ${EMAIL_FROM}`);
  console.log(`  APP_BASE_URL    = ${APP_BASE_URL}`);
  console.log(`  RESEND_API_KEY  = ${process.env.RESEND_API_KEY ? '<set>' : '<unset>'}`);
  console.log(`  → recipient     = ${recipient}`);
  console.log('');

  if (PROVIDER === 'noop') {
    console.warn('WARNING: EMAIL_PROVIDER is "noop". The send will appear to succeed but no');
    console.warn('email will actually be delivered. Set EMAIL_PROVIDER=resend (+ RESEND_API_KEY)');
    console.warn('to exercise the real pipeline.');
    console.log('');
  }

  const fakeToken = 'smoke-test-' + Math.random().toString(36).slice(2, 14);

  const result = await transactionalEmail.sendVerificationEmail({
    to: recipient,
    companyName: 'Smoke Test Co',
    token: fakeToken,
  });

  if (result.ok) {
    console.log(`✓ send succeeded — provider message id: ${result.id}`);
    if (PROVIDER === 'resend') {
      console.log('');
      console.log('Check the recipient inbox (and the spam folder). Resend dashboard:');
      console.log('  https://resend.com/emails');
    }
    process.exit(0);
  }

  console.error(`✗ send failed`);
  console.error(`  reason: ${result.reason}`);
  if (result.error) {
    const detail = typeof result.error === 'string' ? result.error : JSON.stringify(result.error);
    console.error(`  error:  ${detail}`);
  }
  if (result.reason === 'not_configured') {
    console.error('');
    console.error('Set RESEND_API_KEY in .env (or on Render → Environment).');
    console.error('Get a key at https://resend.com → API keys.');
  } else if (result.reason === 'provider_error') {
    console.error('');
    console.error('Resend rejected the send. Common causes:');
    console.error('  - API key invalid / revoked');
    console.error('  - EMAIL_FROM uses a domain not verified in your Resend account');
    console.error('    (onboarding@resend.dev always works as a fallback)');
    console.error('  - Recipient domain bouncing / rate-limited');
  }
  process.exit(1);
}

main().catch((err) => {
  console.error('[smoke-test-email] unexpected error:', err.message);
  process.exit(1);
});
