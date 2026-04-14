const { Router } = require('express');
const { z } = require('zod');
const { validate, validateQuery } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const runReportService = require('../services/runReportService');
const emailService = require('../services/emailService');
const { NotFoundError } = require('../utils/apiError');
const db = require('../db');

const router = Router();
router.use(authenticate);

// GET /api/run-reports - list reports with pagination
router.get('/', async (req, res, next) => {
  try {
    const { runType, status, page = 1, limit = 20 } = req.query;
    const reports = await runReportService.listRunReports(req.user.id, {
      runType, status, page: parseInt(page), limit: parseInt(limit)
    });
    res.json(reports);
  } catch (err) { next(err); }
});

// GET /api/run-reports/api-summary - API runs summary for dashboard
router.get('/api-summary', async (req, res, next) => {
  try {
    const summary = await runReportService.getApiRunsSummary(req.user.id);
    res.json(summary);
  } catch (err) { next(err); }
});

// GET /api/run-reports/automation-summary - Automation runs summary for dashboard
router.get('/automation-summary', async (req, res, next) => {
  try {
    const summary = await runReportService.getAutomationRunsSummary(req.user.id);
    res.json(summary);
  } catch (err) { next(err); }
});

// GET /api/run-reports/:id - get full report detail
router.get('/:id', async (req, res, next) => {
  try {
    const report = await runReportService.getRunReport(req.user.id, req.params.id);
    res.json(report);
  } catch (err) { next(err); }
});

// POST /api/run-reports/:id/send-email - send report email
router.post('/:id/send-email', async (req, res, next) => {
  try {
    const { email } = req.body;
    const report = await runReportService.getRunReport(req.user.id, req.params.id);
    
    // Get user email if not provided
    let recipientEmail = email;
    if (!recipientEmail) {
      const user = await db.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
      recipientEmail = user.rows[0]?.email;
    }
    
    if (!recipientEmail) {
      return res.status(400).json({ error: { message: 'Email address required' } });
    }
    
    const result = await emailService.sendReportEmail(req.user.id, report, recipientEmail);
    res.json({ message: 'Report email queued', emailId: result.id });
  } catch (err) { next(err); }
});

// GET /api/run-reports/:id/download - download report as file
router.get('/:id/download', async (req, res, next) => {
  try {
    const format = req.query.format || 'json';
    const report = await runReportService.getRunReport(req.user.id, req.params.id);
    
    if (format === 'json') {
      res.setHeader('Content-Disposition', `attachment; filename="report-${report.id}.json"`);
      res.json(report);
    } else if (format === 'csv') {
      const csv = generateReportCSV(report);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="report-${report.id}.csv"`);
      res.send(csv);
    } else {
      res.status(400).json({ error: { message: 'Unsupported format' } });
    }
  } catch (err) { next(err); }
});

// DELETE /api/run-reports/:id - delete report
router.delete('/:id', async (req, res, next) => {
  try {
    const result = await db.query(
      'DELETE FROM run_reports WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) throw new NotFoundError('Report');
    res.json({ message: 'Report deleted' });
  } catch (err) { next(err); }
});

function generateReportCSV(report) {
  const headers = ['Test Name', 'Status', 'Duration (ms)', 'Error', 'Executed At'];
  const rows = (report.testResults || []).map(r => [
    r.name || '',
    r.status || '',
    r.duration || 0,
    (r.error || '').replace(/"/g, '""'),
    r.executedAt || ''
  ]);
  
  const csvContent = [
    `# TestForge Run Report`,
    `# Title: ${report.title || 'N/A'}`,
    `# Run Type: ${report.runType}`,
    `# Total: ${report.totalTests}, Passed: ${report.passedCount}, Failed: ${report.failedCount}`,
    `# Duration: ${report.totalDurationMs}ms`,
    `# Completed: ${report.completedAt}`,
    '',
    headers.join(','),
    ...rows.map(r => r.map(cell => `"${cell}"`).join(','))
  ].join('\n');
  
  return csvContent;
}

module.exports = router;
