/**
 * Email Service using Resend
 * 
 * Free tier: 3,000 emails/month
 * Setup: https://resend.com → Create API key → Add to Railway env vars
 */

const logger = require('../utils/logger');

// Resend API endpoint
const RESEND_API_URL = 'https://api.resend.com/emails';

/**
 * Send an email using Resend API
 */
async function sendEmail({ to, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.EMAIL_FROM || 'TestForge <onboarding@resend.dev>';

  if (!apiKey) {
    console.log('[EMAIL] RESEND_API_KEY not configured - email skipped');
    console.log('[EMAIL] Would send to:', to);
    console.log('[EMAIL] Subject:', subject);
    return { success: false, reason: 'RESEND_API_KEY not configured' };
  }

  console.log('[EMAIL] Attempting to send email to:', to);
  console.log('[EMAIL] From:', fromEmail);
  console.log('[EMAIL] Subject:', subject);

  try {
    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
        text,
      }),
    });

    const data = await response.json();
    console.log('[EMAIL] Resend API response:', JSON.stringify(data));

    if (!response.ok) {
      console.error('[EMAIL] Failed to send email:', data);
      logger.error({ to, subject, error: data }, 'Failed to send email');
      return { success: false, reason: data.message || data.error?.message || 'Failed to send email' };
    }

    console.log('[EMAIL] Email sent successfully, ID:', data.id);
    logger.info({ to, subject, id: data.id }, 'Email sent successfully');
    return { success: true, id: data.id };
  } catch (err) {
    console.error('[EMAIL] Email service error:', err.message);
    logger.error({ err, to, subject }, 'Email service error');
    return { success: false, reason: err.message };
  }
}

/**
 * Send team invite email
 */
async function sendInviteEmail({ email, inviteUrl, organizationName, role, inviterEmail }) {
  const appUrl = process.env.FRONTEND_URL || 'https://testforge-app.vercel.app';
  const fullInviteUrl = `${appUrl}${inviteUrl}`;

  console.log('[EMAIL] Preparing invite email');
  console.log('[EMAIL] To:', email);
  console.log('[EMAIL] Org:', organizationName);
  console.log('[EMAIL] Invite URL:', fullInviteUrl);

  const subject = `You're invited to join ${organizationName} on TestForge`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Join ${organizationName} on TestForge</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f4f4f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f4f5; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #0f172a 0%, #1e3a5f 100%); padding: 32px 40px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600;">
                🧪 TestForge
              </h1>
              <p style="margin: 8px 0 0; color: #94a3b8; font-size: 14px;">
                Build. Run. Trust your tests.
              </p>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              <h2 style="margin: 0 0 16px; color: #0f172a; font-size: 20px; font-weight: 600;">
                You've been invited! 🎉
              </h2>
              
              <p style="margin: 0 0 24px; color: #475569; font-size: 16px; line-height: 1.6;">
                <strong>${inviterEmail}</strong> has invited you to join 
                <strong>${organizationName}</strong> on TestForge as a <strong>${role}</strong>.
              </p>
              
              <p style="margin: 0 0 32px; color: #475569; font-size: 16px; line-height: 1.6;">
                TestForge helps QA teams create projects, manage test cases, and leverage AI to find coverage gaps, detect duplicates, and assess quality automatically.
              </p>
              
              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center">
                    <a href="${fullInviteUrl}" 
                       style="display: inline-block; background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 6px; font-size: 16px; font-weight: 600; box-shadow: 0 4px 6px rgba(14, 165, 233, 0.3);">
                      Accept Invite
                    </a>
                  </td>
                </tr>
              </table>
              
              <p style="margin: 32px 0 0; color: #94a3b8; font-size: 14px; text-align: center;">
                This invite expires in 7 days.
              </p>
              
              <!-- Link fallback -->
              <p style="margin: 24px 0 0; color: #94a3b8; font-size: 12px; word-break: break-all;">
                If the button doesn't work, copy and paste this link:<br>
                <a href="${fullInviteUrl}" style="color: #0ea5e9;">${fullInviteUrl}</a>
              </p>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="background-color: #f8fafc; padding: 24px 40px; border-top: 1px solid #e2e8f0;">
              <p style="margin: 0; color: #94a3b8; font-size: 12px; text-align: center;">
                © ${new Date().getFullYear()} TestForge. All rights reserved.<br>
                You received this email because someone invited you to TestForge.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

  const text = `
You've been invited to join ${organizationName} on TestForge!

${inviterEmail} has invited you to join as a ${role}.

TestForge helps QA teams create projects, manage test cases, and leverage AI to find coverage gaps, detect duplicates, and assess quality automatically.

Accept your invite: ${fullInviteUrl}

This invite expires in 7 days.

---
© ${new Date().getFullYear()} TestForge
`;

  return sendEmail({ to: email, subject, html, text });
}

/**
 * Send welcome email after accepting invite
 */
async function sendWelcomeEmail({ email, organizationName }) {
  const appUrl = process.env.FRONTEND_URL || 'https://testforge-app.vercel.app';

  const subject = `Welcome to ${organizationName} on TestForge! 🎉`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f4f4f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f4f5; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden;">
          <tr>
            <td style="background: linear-gradient(135deg, #0f172a 0%, #1e3a5f 100%); padding: 32px 40px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 24px;">🧪 TestForge</h1>
            </td>
          </tr>
          <tr>
            <td style="padding: 40px;">
              <h2 style="margin: 0 0 16px; color: #0f172a;">Welcome to the team! 🎉</h2>
              <p style="margin: 0 0 24px; color: #475569; line-height: 1.6;">
                You've successfully joined <strong>${organizationName}</strong> on TestForge.
              </p>
              <p style="margin: 0 0 32px; color: #475569; line-height: 1.6;">
                Get started by exploring your projects and creating test cases.
              </p>
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center">
                    <a href="${appUrl}" style="display: inline-block; background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 6px; font-weight: 600;">
                      Go to TestForge
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

  return sendEmail({ to: email, subject, html, text: `Welcome to ${organizationName} on TestForge! Visit ${appUrl} to get started.` });
}

module.exports = {
  sendEmail,
  sendInviteEmail,
  sendWelcomeEmail,
};
