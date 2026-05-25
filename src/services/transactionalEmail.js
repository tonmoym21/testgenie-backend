// Transactional email service — immediate, single-recipient, low-volume
// emails tied to auth/signup flows (verification, password reset, invite
// accept, etc.). Separate from the queued report delivery in
// emailService.js because the concerns are different:
//
//   emailService.js              transactionalEmail.js (this file)
//   ─────────────────────        ─────────────────────────────────
//   Queued + retried             Send-once, fire-immediately
//   Batch report delivery        Auth + signup flows
//   Nodemailer (SMTP/SendGrid)   Resend (better DX, lower failure rate)
//   Failure non-blocking         Failure surfaces to caller
//
// Environment:
//   EMAIL_PROVIDER   'resend' | 'noop'   default 'noop' so dev/test
//                    boots without credentials
//   RESEND_API_KEY   required when EMAIL_PROVIDER=resend
//   EMAIL_FROM       sender address; defaults to onboarding@resend.dev
//                    (Resend's free sandbox sender — replace with
//                    noreply@testforge.com once the domain is verified
//                    in Resend)
//   APP_BASE_URL     used to build verification links in templates
//
// Failure model: send*() functions NEVER throw. They return
//   { ok: true,  id }
//   { ok: false, reason, error? }
// Callers decide whether the failure is fatal (signup) or fire-and-
// forget (notification). Keeps the request hot path resilient to
// email-provider outages.

const logger = require('../utils/logger');

const PROVIDER = (process.env.EMAIL_PROVIDER || 'noop').toLowerCase();
const EMAIL_FROM = process.env.EMAIL_FROM || 'onboarding@resend.dev';
const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://testforge-app.vercel.app').replace(/\/$/, '');

let _resendClient = null;
function getResendClient() {
  if (_resendClient) return _resendClient;
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  // Lazy-require so the SDK isn't loaded in noop mode (keeps test/CI
  // boots fast and avoids dragging in the dep tree until needed).
  const { Resend } = require('resend');
  _resendClient = new Resend(key);
  return _resendClient;
}

// Exposed for tests so a swap to a different key in beforeEach picks up.
function _resetForTests() {
  _resendClient = null;
}

async function send({ to, subject, html, text }) {
  if (!to || !subject || (!html && !text)) {
    return { ok: false, reason: 'missing_fields' };
  }

  if (PROVIDER === 'noop') {
    logger.info(
      { to, subject, preview: (text || html).slice(0, 200) },
      '[txn-email:noop] would send'
    );
    return { ok: true, id: 'noop' };
  }

  if (PROVIDER === 'resend') {
    const client = getResendClient();
    if (!client) {
      logger.warn({ to, subject }, '[txn-email:resend] RESEND_API_KEY not set — not sending');
      return { ok: false, reason: 'not_configured' };
    }
    try {
      const result = await client.emails.send({
        from: EMAIL_FROM,
        to,
        subject,
        html: html || undefined,
        text: text || undefined,
      });
      if (result.error) {
        logger.error({ to, subject, error: result.error }, '[txn-email:resend] send failed');
        return { ok: false, reason: 'provider_error', error: result.error };
      }
      logger.info({ to, subject, id: result.data && result.data.id }, '[txn-email:resend] sent');
      return { ok: true, id: result.data && result.data.id };
    } catch (err) {
      logger.error({ to, subject, err: err.message }, '[txn-email:resend] threw');
      return { ok: false, reason: 'exception', error: err.message };
    }
  }

  logger.error({ provider: PROVIDER }, '[txn-email] unknown EMAIL_PROVIDER');
  return { ok: false, reason: 'unknown_provider' };
}

// ── Templates ──────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function verificationEmail({ companyName, email, token }) {
  const link = `${APP_BASE_URL}/verify-email?token=${encodeURIComponent(token)}`;
  const subject = `Verify your email to finish creating ${companyName} on TestForge`;
  const text = [
    `Hi,`,
    ``,
    `You're almost set up. Click the link below to verify ${email} and finish creating your "${companyName}" organization on TestForge:`,
    ``,
    link,
    ``,
    `This link expires in 24 hours. If you didn't request this, you can safely ignore the email — no account or organization will be created.`,
    ``,
    `— TestForge`,
  ].join('\n');

  const html = `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1a1a1a;">
  <h2 style="margin:0 0 16px;font-weight:600;">Verify your email</h2>
  <p style="margin:0 0 16px;line-height:1.5;">You're almost set up. Click the button below to verify <strong>${escapeHtml(email)}</strong> and finish creating your <strong>${escapeHtml(companyName)}</strong> organization on TestForge.</p>
  <p style="margin:24px 0;">
    <a href="${escapeHtml(link)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:500;">Verify email</a>
  </p>
  <p style="margin:0 0 8px;font-size:13px;color:#666;line-height:1.5;">Or paste this link into your browser:</p>
  <p style="margin:0 0 24px;font-size:13px;word-break:break-all;"><a href="${escapeHtml(link)}" style="color:#0a66c2;">${escapeHtml(link)}</a></p>
  <p style="margin:0;font-size:13px;color:#666;line-height:1.5;">This link expires in 24 hours. If you didn't request this, you can safely ignore the email — no account or organization will be created.</p>
</body></html>`;

  return { subject, text, html };
}

async function sendVerificationEmail({ to, companyName, token }) {
  const { subject, text, html } = verificationEmail({ companyName, email: to, token });
  return send({ to, subject, text, html });
}

module.exports = {
  send,
  sendVerificationEmail,
  // Exposed for tests + observability
  _internal: { verificationEmail, _resetForTests, PROVIDER, EMAIL_FROM, APP_BASE_URL },
};
