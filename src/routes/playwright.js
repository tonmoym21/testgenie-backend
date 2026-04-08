// src/routes/playwright.js
// Routes for Playwright test generation (V1.5 Drop 1)
//
// Mounted at: /api/projects/:projectId/playwright
// Requires: verifyToken middleware (from index.js or inline)

const express = require('express');
const router = express.Router({ mergeParams: true }); // access :projectId
const db = require('../db');
const { generatePlaywrightFiles, generateReadme } = require('../services/playwrightGenerator');
const { buildPlaywrightZip } = require('../utils/zipGenerator');

// ---------------------------------------------------------------------------
// POST /api/projects/:projectId/playwright/generate
// Generate Playwright ZIP from a story's approved scenarios
// ---------------------------------------------------------------------------
router.post('/generate', async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user.id;
  const { storyIngestionId, categories = [] } = req.body;

  // --- Validate input ---
  if (!storyIngestionId) {
    return res.status(400).json({ error: 'storyIngestionId is required' });
  }

  if (!Array.isArray(categories)) {
    return res.status(400).json({ error: 'categories must be an array' });
  }

  const allowedCategories = ['smoke', 'regression', 'sanity', 'critical_path', 'e2e'];
  const invalid = categories.filter((c) => !allowedCategories.includes(c));
  if (invalid.length > 0) {
    return res.status(400).json({ error: `Invalid categories: ${invalid.join(', ')}` });
  }

  try {
    // --- Verify story belongs to project + user ---
    const storyRes = await db.query(
      `SELECT id, title FROM stories
      WHERE id = $1 AND project_id = $2 AND user_id = $3`,
      [storyIngestionId, projectId, userId]
    );
    if (storyRes.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found in this project' });
    }
    const storyTitle = storyRes.rows[0].title || 'Untitled Story';

// --- Fetch approved scenarios directly ---
    const scenRes = await db.query(
      `SELECT id, category, title, summary, preconditions, test_intent,
              inputs, expected_outcome, priority
       FROM scenarios
       WHERE story_id = $1 AND status = 'approved'
       ORDER BY category, created_at`,
      [storyIngestionId]
    );
    if (scenRes.rows.length === 0) {
      return res.status(400).json({
        error: 'No approved scenarios. Approve scenarios before generating Playwright tests.',
      });
    }
    const scenarios = scenRes.rows;

    // --- Create DB record (status=generating) ---
    const insertRes = await db.query(
      `INSERT INTO generated_tests
         (project_id, user_id, story_ingestion_id, scenario_ids, categories, status)
       VALUES ($1, $2, $3, $4, $5, 'generating')
       RETURNING id`,
      [
        projectId,
        userId,
        storyIngestionId,
        JSON.stringify(scenarios.map((s) => s.id)),
        JSON.stringify(categories),
      ]
    );
    const genTestId = insertRes.rows[0].id;

    // --- Call OpenAI to generate Playwright code ---
    let generated;
    try {
      generated = await generatePlaywrightFiles(scenarios, categories);
    } catch (aiErr) {
      await db.query(
        `UPDATE generated_tests SET status = 'failed', error_message = $1, completed_at = now()
         WHERE id = $2`,
        [aiErr.message, genTestId]
      );
      return res.status(502).json({ error: 'Playwright generation failed', detail: aiErr.message });
    }

    // --- Build ZIP ---
    const readme = generateReadme(storyTitle, scenarios.length, categories);
    const zipBuffer = await buildPlaywrightZip(generated, readme);
    const zipBase64 = zipBuffer.toString('base64');
    const zipFileName = `playwright-${storyIngestionId.slice(0, 8)}-${Date.now()}.zip`;

    const fileCount =
      (generated.specs?.length || 0) +
      (generated.pages?.length || 0) +
      (generated.testData ? 1 : 0) +
      (generated.config ? 1 : 0) +
      2; // README + package.json

    // --- Update DB record ---
    await db.query(
      `UPDATE generated_tests
       SET status = 'completed',
           zip_base64 = $1,
           zip_file_name = $2,
           zip_size_bytes = $3,
           test_file_count = $4,
           completed_at = now()
       WHERE id = $5`,
      [zipBase64, zipFileName, zipBuffer.length, fileCount, genTestId]
    );

    return res.status(201).json({
      id: genTestId,
      status: 'completed',
      zipFileName,
      zipSizeBytes: zipBuffer.length,
      testFileCount: fileCount,
      scenarioCount: scenarios.length,
      categories,
    });
  } catch (err) {
    req.log?.error(err, 'Playwright generation error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/projects/:projectId/playwright
// List generated test sets for this project
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user.id;

  try {
    const result = await db.query(
      `SELECT id, story_ingestion_id, scenario_ids, categories, status,
              test_file_count, zip_file_name, zip_size_bytes, error_message,
              created_at, completed_at
       FROM generated_tests
       WHERE project_id = $1 AND user_id = $2
       ORDER BY created_at DESC
       LIMIT 50`,
      [projectId, userId]
    );

    return res.json({ tests: result.rows });
  } catch (err) {
    req.log?.error(err, 'List generated tests error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/projects/:projectId/playwright/:id/download
// Download the ZIP file
// ---------------------------------------------------------------------------
router.get('/:id/download', async (req, res) => {
  const { projectId, id } = req.params;
  const userId = req.user.id;

  try {
    const result = await db.query(
      `SELECT zip_base64, zip_file_name, zip_size_bytes, status
       FROM generated_tests
       WHERE id = $1 AND project_id = $2 AND user_id = $3`,
      [id, projectId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Generated test not found' });
    }

    const row = result.rows[0];
    if (row.status !== 'completed' || !row.zip_base64) {
      return res.status(400).json({ error: 'ZIP not available (status: ' + row.status + ')' });
    }

    const zipBuffer = Buffer.from(row.zip_base64, 'base64');

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${row.zip_file_name}"`);
    res.setHeader('Content-Length', zipBuffer.length);
    return res.send(zipBuffer);
  } catch (err) {
    req.log?.error(err, 'Download ZIP error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
