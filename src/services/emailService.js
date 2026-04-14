const db = require('../db');
const logger = require('../utils/logger');

/**
 * Email Service
 * Handles email queuing and delivery for run reports
 * Supports Nodemailer with configurable providers (SMTP, SendGrid, etc.)
 */

let transporter = null;

/**
 * Initialize email transporter based on config
 */
async function initTransporter() {
  if (transporter) return transporter;
  
  // Check if email is configured
  const smtpHost = process.env.SMTP_HOST;
  const sendgridKey = process.env.SENDGRID_API_KEY;
  
  if (!smtpHost && !sendgridKey) {
    logger.warn('Email not configured - SMTP_HOST or SENDGRID_API_KEY required');
    return null;
  }
  
  try {
    const nodemailer = require('nodemailer');
    
    if (sendgridKey) {
      // SendGrid transport
      transporter = nodemailer.createTransport({
        host: 'smtp.sendgrid.net',
        port: 587,
        auth: {
          user: 'apikey',
          pass: sendgridKey
        }
      });
    } else {
      // Generic SMTP transport
      transporter = nodemailer.createTransport({
        host: smtpHost,
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER ? {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        } : undefined
      });
    }
    
    await transporter.verify();
    logger.info('Email transporter initialized');
    return transporter;
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to initialize email transporter');
    return null;
  }
}

/**
 * Queue an email for delivery
 */
async function queueEmail(userId, { recipientEmail, subject, bodyHtml, bodyText, reportId }) {
  const result = await db.query(
    `INSERT INTO email_queue 
     (user_id, recipient_email, subject, body_html, body_text, report_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')
     RETURNING id`,
    [userId, recipientEmail, subject, bodyHtml, bodyText || '', reportId || null]
  );
  
  logger.info({ userId, emailId: result.rows[0].id, recipientEmail }, 'Email queued');
  
  // Try to send immediately
  setImmediate(() => processEmailQueue());
  
  return result.rows[0];
}

/**
 * Process pending emails in the queue
 */
async function processEmailQueue() {
  const transport = await initTransporter();
  if (!transport) {
    logger.debug('Email transport not available, skipping queue processing');
    return;
  }
  
  // Get pending emails
  const pending = await db.query(
    `SELECT * FROM email_queue 
     WHERE status = 'pending' AND attempts < max_attempts
     ORDER BY scheduled_at ASC LIMIT 10`
  );
  
  for (const email of pending.rows) {
    try {
      await db.query(
        `UPDATE email_queue SET status = 'sending', attempts = attempts + 1 WHERE id = $1`,
        [email.id]
      );
      
      await transport.sendMail({
        from: process.env.EMAIL_FROM || 'TestForge <noreply@testforge.app>',
        to: email.recipient_email,
        subject: email.subject,
        html: email.body_html,
        text: email.body_text
      });
      
      await db.query(
        `UPDATE email_queue SET status = 'sent', sent_at = NOW() WHERE id = $1`,
        [email.id]
      );
      
      logger.info({ emailId: email.id, recipient: email.recipient_email }, 'Email sent');
    } catch (err) {
      const shouldRetry = email.attempts + 1 < email.max_attempts;
      await db.query(
        `UPDATE email_queue SET status = $1, last_error = $2 WHERE id = $3`,
        [shouldRetry ? 'pending' : 'failed', err.message, email.id]
      );
      logger.error({ emailId: email.id, err: err.message }, 'Email send failed');
    }
  }
}

/**
 * Generate report completion email
 */
function generateReportEmail(report, userEmail) {
  const passRate = report.totalTests > 0 
    ? Math.round((report.passedCount / report.totalTests) * 100) 
    : 0;
  
  const statusColor = report.failedCount === 0 ? '#22c55e' : '#ef4444';
  const statusText = report.failedCount === 0 ? 'PASSED' : 'FAILED';
  
  const subject = `[TestForge] ${report.title || 'Test Run'} - ${statusText} (${passRate}% pass rate)`;
  
  const bodyHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #374151; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); color: white; padding: 24px; border-radius: 12px 12px 0 0; }
    .header h1 { margin: 0; font-size: 20px; }
    .content { background: #fff; border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 12px 12px; }
    .status-badge { display: inline-block; padding: 6px 16px; border-radius: 20px; font-weight: 600; font-size: 14px; color: white; background: ${statusColor}; }
    .stats { display: flex; gap: 16px; margin: 20px 0; }
    .stat { flex: 1; text-align: center; padding: 16px; background: #f9fafb; border-radius: 8px; }
    .stat-value { font-size: 28px; font-weight: 700; color: #111827; }
    .stat-label { font-size: 12px; color: #6b7280; text-transform: uppercase; }
    .passed .stat-value { color: #22c55e; }
    .failed .stat-value { color: #ef4444; }
    .details { margin-top: 20px; padding-top: 20px; border-top: 1px solid #e5e7eb; }
    .details-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f3f4f6; }
    .btn { display: inline-block; padding: 12px 24px; background: #6366f1; color: white; text-decoration: none; border-radius: 8px; font-weight: 600; margin-top: 20px; }
    .footer { text-align: center; margin-top: 24px; font-size: 12px; color: #9ca3af; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🧪 TestForge Report</h1>
    </div>
    <div class="content">
      <h2 style="margin-top:0">${report.title || 'Test Run Complete'}</h2>
      <span class="status-badge">${statusText}</span>
      
      <div class="stats">
        <div class="stat">
          <div class="stat-value">${report.totalTests}</div>
          <div class="stat-label">Total Tests</div>
        </div>
        <div class="stat passed">
          <div class="stat-value">${report.passedCount}</div>
          <div class="stat-label">Passed</div>
        </div>
        <div class="stat failed">
          <div class="stat-value">${report.failedCount}</div>
          <div class="stat-label">Failed</div>
        </div>
        <div class="stat">
          <div class="stat-value">${passRate}%</div>
          <div class="stat-label">Pass Rate</div>
        </div>
      </div>
      
      <div class="details">
        <div class="details-row">
          <span>Duration</span>
          <strong>${(report.totalDurationMs / 1000).toFixed(2)}s</strong>
        </div>
        <div class="details-row">
          <span>Run Type</span>
          <strong>${report.runType}</strong>
        </div>
        ${report.environmentName ? `<div class="details-row"><span>Environment</span><strong>${report.environmentName}</strong></div>` : ''}
        <div class="details-row">
          <span>Completed</span>
          <strong>${new Date(report.completedAt).toLocaleString()}</strong>
        </div>
      </div>
      
      <a href="${process.env.FRONTEND_URL || 'https://testforge.app'}/reports/${report.id}" class="btn">View Full Report</a>
    </div>
    <div class="footer">
      <p>You're receiving this because you have notifications enabled for test runs.</p>
      <p>TestForge - Build. Run. Trust.</p>
    </div>
  </div>
</body>
</html>`;

  const bodyText = `
TestForge Report: ${report.title || 'Test Run Complete'}
Status: ${statusText}

Summary:
- Total Tests: ${report.totalTests}
- Passed: ${report.passedCount}
- Failed: ${report.failedCount}
- Pass Rate: ${passRate}%
- Duration: ${(report.totalDurationMs / 1000).toFixed(2)}s

View full report: ${process.env.FRONTEND_URL || 'https://testforge.app'}/reports/${report.id}
`;

  return { subject, bodyHtml, bodyText };
}

/**
 * Send report completion email
 */
async function sendReportEmail(userId, report, recipientEmail) {
  const { subject, bodyHtml, bodyText } = generateReportEmail(report, recipientEmail);
  return queueEmail(userId, {
    recipientEmail,
    subject,
    bodyHtml,
    bodyText,
    reportId: report.id
  });
}

/**
 * Get email queue status
 */
async function getEmailQueueStatus(userId) {
  const result = await db.query(
    `SELECT status, COUNT(*)::int AS count
     FROM email_queue WHERE user_id = $1
     GROUP BY status`,
    [userId]
  );
  
  return result.rows.reduce((acc, row) => {
    acc[row.status] = row.count;
    return acc;
  }, { pending: 0, sending: 0, sent: 0, failed: 0 });
}

// Start periodic queue processing
setInterval(processEmailQueue, 60000);

module.exports = {
  queueEmail, processEmailQueue, generateReportEmail,
  sendReportEmail, getEmailQueueStatus, initTransporter
};
