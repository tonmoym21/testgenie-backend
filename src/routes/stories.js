const { Router } = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { scenarioToCsvRows } = require('../utils/csvTransformer');
const { generateScenarios } = require('../services/scenarioGenerator');
const logger = require('../utils/logger');

const router = Router({ mergeParams: true });

// Helper: verify project ownership
async function verifyProjectOwnership(projectId, userId) {
  const result = await db.query(
    'SELECT id FROM projects WHERE id = $1 AND user_id = $2',
    [projectId, userId]
  );
  return result.rows.length > 0;
}

// POST /api/projects/:projectId/stories
router.post('/', authenticate, async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;

    if (!(await verifyProjectOwnership(projectId, userId))) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not your project' } });
    }

    const { title, description, sourceType, sourceUrl } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Title is required' } });
    }
    if (!description || description.trim().length < 20) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Description must be at least 20 characters' } });
    }

    const result = await db.query(
      `INSERT INTO stories (project_id, user_id, title, description, source_type, source_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [projectId, userId, title.trim(), description.trim(), sourceType || 'text', sourceUrl || null]
    );

    const story = result.rows[0];

    // Generate scenarios using OpenAI (with rule-based fallback)
    let scenarios;
    try {
      scenarios = await generateScenarios({ title: story.title, description: story.description });
    } catch (genErr) {
      logger.error({ err: genErr.message, storyId: story.id }, 'Scenario generation failed completely');
      scenarios = [];
    }

    if (scenarios.length > 0) {
      const values = [];
      const placeholders = [];
      let idx = 1;
      for (const s of scenarios) {
        placeholders.push(
          `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`
        );
        values.push(
          story.id, projectId, userId,
          s.category, s.title, s.summary || '',
          JSON.stringify(s.preconditions || []), s.test_intent || '',
          s.expected_outcome || '', s.priority || 'P1'
        );
      }
      await db.query(
        `INSERT INTO scenarios (story_id, project_id, user_id, category, title, summary, preconditions, test_intent, expected_outcome, priority)
         VALUES ${placeholders.join(', ')}`,
        values
      );
      await db.query(
        `UPDATE stories SET status = 'extracted', updated_at = NOW() WHERE id = $1`,
        [story.id]
      );
      story.status = 'extracted';

      logger.info({ storyId: story.id, scenarioCount: scenarios.length }, 'Scenarios generated for story');
    }

    res.status(201).json(story);
  } catch (err) {
    next(err);
  }
});

// GET /api/projects/:projectId/stories
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;

    if (!(await verifyProjectOwnership(projectId, userId))) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not your project' } });
    }

    const result = await db.query(
      `SELECT s.*,
        (SELECT count(*) FROM scenarios sc WHERE sc.story_id = s.id)::int AS scenario_count,
        (SELECT count(*) FROM scenarios sc WHERE sc.story_id = s.id AND sc.status = 'approved')::int AS approved_count
       FROM stories s
       WHERE s.project_id = $1 AND s.user_id = $2
       ORDER BY s.created_at DESC`,
      [projectId, userId]
    );

    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/projects/:projectId/stories/:storyId
router.get('/:storyId', authenticate, async (req, res, next) => {
  try {
    const { projectId, storyId } = req.params;
    const userId = req.user.id;

    const result = await db.query(
      'SELECT * FROM stories WHERE id = $1 AND project_id = $2 AND user_id = $3',
      [storyId, projectId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Story not found' } });
    }

    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/projects/:projectId/stories/:storyId
router.delete('/:storyId', authenticate, async (req, res, next) => {
  try {
    const { projectId, storyId } = req.params;
    const userId = req.user.id;

    const result = await db.query(
      'DELETE FROM stories WHERE id = $1 AND project_id = $2 AND user_id = $3 RETURNING id',
      [storyId, projectId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Story not found' } });
    }

    res.json({ message: 'Story deleted' });
  } catch (err) {
    next(err);
  }
});

// GET /api/projects/:projectId/stories/:storyId/scenarios
router.get('/:storyId/scenarios', authenticate, async (req, res, next) => {
  try {
    const { projectId, storyId } = req.params;
    const userId = req.user.id;

    const storyCheck = await db.query(
      'SELECT id FROM stories WHERE id = $1 AND project_id = $2 AND user_id = $3',
      [storyId, projectId, userId]
    );
    if (storyCheck.rows.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Story not found' } });
    }

    const result = await db.query(
      `SELECT * FROM scenarios WHERE story_id = $1 ORDER BY
        CASE category
          WHEN 'happy_path' THEN 1 WHEN 'negative' THEN 2
          WHEN 'edge' THEN 3 WHEN 'validation' THEN 4
          WHEN 'role_permission' THEN 5 WHEN 'state_transition' THEN 6
          WHEN 'api_impact' THEN 7 WHEN 'non_functional' THEN 8
        END, created_at`,
      [storyId]
    );

    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/projects/:projectId/stories/:storyId/scenarios/:scenarioId
router.patch('/:storyId/scenarios/:scenarioId', authenticate, async (req, res, next) => {
  try {
    const { projectId, storyId, scenarioId } = req.params;
    const userId = req.user.id;
    const { status, reviewNote } = req.body;

    if (!status || !['approved', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Status must be approved, rejected, or pending' } });
    }

    const storyCheck = await db.query(
      'SELECT id FROM stories WHERE id = $1 AND project_id = $2 AND user_id = $3',
      [storyId, projectId, userId]
    );
    if (storyCheck.rows.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Story not found' } });
    }

    const result = await db.query(
      `UPDATE scenarios SET status = $1, review_note = $2, updated_at = NOW()
       WHERE id = $3 AND story_id = $4 RETURNING *`,
      [status, reviewNote || null, scenarioId, storyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Scenario not found' } });
    }

    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/projects/:projectId/stories/:storyId/export-csv
router.post('/:storyId/export-csv', authenticate, async (req, res, next) => {
  try {
    const { projectId, storyId } = req.params;
    const userId = req.user.id;

    const storyResult = await db.query(
      'SELECT id, title FROM stories WHERE id = $1 AND project_id = $2 AND user_id = $3',
      [storyId, projectId, userId]
    );
    if (storyResult.rows.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Story not found' } });
    }

    const story = storyResult.rows[0];

    const scenariosResult = await db.query(
      `SELECT id, category, title, summary, preconditions, test_intent,
              inputs, expected_outcome, priority
       FROM scenarios
       WHERE story_id = $1 AND status = 'approved'
       ORDER BY
         CASE category
           WHEN 'happy_path' THEN 1 WHEN 'negative' THEN 2
           WHEN 'edge' THEN 3 WHEN 'validation' THEN 4
           WHEN 'role_permission' THEN 5 WHEN 'state_transition' THEN 6
           WHEN 'api_impact' THEN 7 WHEN 'non_functional' THEN 8
         END, created_at`,
      [storyId]
    );

    if (scenariosResult.rows.length === 0) {
      return res.status(400).json({
        error: { code: 'NO_DATA', message: 'No approved scenarios to export. Approve at least one scenario first.' }
      });
    }

    const csvContent = scenarioToCsvRows(scenariosResult.rows, story.title);
    const timestamp = new Date().toISOString().split('T')[0];
    const safeTitle = story.title.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 30);
    const filename = safeTitle + '-' + timestamp + '.csv';

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.setHeader('Cache-Control', 'no-store');

    return res.send(csvContent);
  } catch (err) {
    next(err);
  }
});

// GET /api/projects/:projectId/stories/:storyId/coverage
router.get('/:storyId/coverage', authenticate, async (req, res, next) => {
  try {
    const { projectId, storyId } = req.params;
    const userId = req.user.id;

    const storyCheck = await db.query(
      'SELECT id FROM stories WHERE id = $1 AND project_id = $2 AND user_id = $3',
      [storyId, projectId, userId]
    );
    if (storyCheck.rows.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Story not found' } });
    }

    const result = await db.query(
      `SELECT category, status, count(*)::int AS count
       FROM scenarios WHERE story_id = $1
       GROUP BY category, status`,
      [storyId]
    );

    const allCategories = [
      'happy_path', 'negative', 'edge', 'validation',
      'role_permission', 'state_transition', 'api_impact', 'non_functional'
    ];

    const byCategory = {};
    let total = 0, approved = 0, rejected = 0, pending = 0;

    for (const row of result.rows) {
      if (!byCategory[row.category]) byCategory[row.category] = { total: 0, approved: 0, rejected: 0, pending: 0 };
      byCategory[row.category][row.status] = (byCategory[row.category][row.status] || 0) + row.count;
      byCategory[row.category].total += row.count;
      total += row.count;
      if (row.status === 'approved') approved += row.count;
      else if (row.status === 'rejected') rejected += row.count;
      else pending += row.count;
    }

    const missingCategories = allCategories.filter(c => !byCategory[c]);
    const coveredCount = allCategories.length - missingCategories.length;
    const qualityScore = Math.round((coveredCount / allCategories.length) * 100);

    res.json({ total, approved, rejected, pending, byCategory, missingCategories, qualityScore, readyForExport: approved > 0 && pending === 0 });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
