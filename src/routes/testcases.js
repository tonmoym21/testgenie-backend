const express = require('express');
const router = express.Router({ mergeParams: true });
const db = require('../db');
const { testCaseToCsvRows } = require('../utils/csvTransformer');
const { authenticate } = require('../middleware/auth');

// [EXISTING ROUTES - testcase CRUD operations]
// GET, POST, PATCH, DELETE routes for test cases...
// (keep all existing testcase routes unchanged)

// NEW: CSV EXPORT ENDPOINT
router.post('/export-csv', authenticate, async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;
    const { testCaseIds } = req.body; // optional: if provided, export only these IDs

    // Verify user has access to project
    if (!projectId) return res.status(400).json({ error: 'Project ID is required' });

    const projectQuery = `
      SELECT id FROM projects 
      WHERE id = $1 AND user_id = $2
    `;
    const projectResult = await db.query(projectQuery, [projectId, userId]);
    if (projectResult.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Build query: get test cases for this project
    let query = `
      SELECT id, title, preconditions, steps, expected_result, notes, priority, category, created_at
      FROM manual_test_cases
      WHERE project_id = $1
      ORDER BY created_at DESC
    `;
    let params = [projectId];

    // If specific test case IDs provided, filter to those
    if (testCaseIds && Array.isArray(testCaseIds) && testCaseIds.length > 0) {
      query = `
        SELECT id, title, preconditions, steps, expected_result, notes, priority, category, created_at
        FROM manual_test_cases
        WHERE project_id = $1 AND id = ANY($2::uuid[])
        ORDER BY created_at DESC
      `;
      params = [projectId, testCaseIds];
    }

    const testCasesResult = await db.query(query, params);

    if (testCasesResult.rows.length === 0) {
      return res.status(400).json({ error: 'No test cases found for export' });
    }

    let csvContent;
    try {
      csvContent = testCaseToCsvRows(testCasesResult.rows);
    } catch (err) {
      console.error('[export-csv] CSV generation failed:', err);
      return res.status(500).json({ error: 'Failed to generate CSV' });
    }

    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `testcases-${projectId.slice(0, 8)}-${timestamp}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

    return res.send(csvContent);
  } catch (error) {
    console.error('[export-csv] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;