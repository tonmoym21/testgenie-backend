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

// Map scenario priority (P0–P3) → test_case priority (critical/high/medium/low)
const SCENARIO_PRIORITY_TO_TC = { P0: 'critical', P1: 'high', P2: 'medium', P3: 'low' };

// Build the manual-test-case `content` field from a scenario row.
function buildTestCaseContentFromScenario(scenario) {
  const parts = [];
  if (scenario.summary) parts.push(scenario.summary.trim());

  let preconditions = scenario.preconditions;
  if (typeof preconditions === 'string') {
    try { preconditions = JSON.parse(preconditions); } catch { preconditions = [preconditions]; }
  }
  if (Array.isArray(preconditions) && preconditions.length > 0) {
    parts.push('\nPreconditions:');
    for (const p of preconditions) parts.push('- ' + String(p));
  }

  if (scenario.expected_outcome) {
    parts.push('\nExpected:\n' + scenario.expected_outcome.trim());
  }
  return parts.join('\n');
}

// Idempotently link an approved scenario to a test_cases row.
// Returns the existing or newly-created test case (with camelCase keys), or null on failure.
async function ensureTestCaseForScenario(scenario, projectId, userId, organizationId) {
  const existing = await db.query(
    `SELECT id, title, content, status, priority, story_id AS "storyId",
            folder_id AS "folderId", scenario_id AS "scenarioId",
            jira_issue_key AS "jiraIssueKey", assignee_user_id AS "assigneeUserId",
            created_at AS "createdAt", updated_at AS "updatedAt", user_id AS "createdBy"
       FROM test_cases WHERE scenario_id = $1`,
    [scenario.id]
  );
  if (existing.rows.length > 0) return existing.rows[0];

  const title = scenario.title;
  const content = buildTestCaseContentFromScenario(scenario);
  const priority = SCENARIO_PRIORITY_TO_TC[scenario.priority] || 'medium';

  // status is left to its column default ('draft') — the test_cases CHECK constraint
  // disallows 'approved', and approval is already represented by the linked scenario.
  const inserted = await db.query(
    `INSERT INTO test_cases (project_id, user_id, title, content, priority, story_id, scenario_id, organization_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, title, content, status, priority, story_id AS "storyId",
               folder_id AS "folderId", scenario_id AS "scenarioId",
               jira_issue_key AS "jiraIssueKey", assignee_user_id AS "assigneeUserId",
               created_at AS "createdAt", updated_at AS "updatedAt", user_id AS "createdBy"`,
    [projectId, userId, title, content, priority, scenario.story_id, scenario.id, organizationId]
  );
  return inserted.rows[0];
}

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

    const scenario = result.rows[0];
    let linkedTestCase = null;

    // On approval, idempotently materialize the scenario into a test_cases row so the user
    // can immediately organize it (keep loose / move to existing folder / create new folder).
    if (status === 'approved') {
      try {
        const userRow = await db.query('SELECT organization_id FROM users WHERE id = $1', [userId]);
        const organizationId = userRow.rows[0]?.organization_id || null;
        linkedTestCase = await ensureTestCaseForScenario(scenario, projectId, userId, organizationId);
      } catch (convErr) {
        logger.error({ err: convErr.message, scenarioId }, 'Failed to materialize test case for approved scenario');
        // Don't fail the approval if conversion blows up — surface scenario update; FE just won't open the modal.
      }
    }

    res.json({ ...scenario, linkedTestCase });
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

// GET /api/projects/:projectId/stories/:storyId/manual-test-cases
router.get('/:storyId/manual-test-cases', authenticate, async (req, res, next) => {
  try {
    const { projectId, storyId } = req.params;
    const { id: userId, orgId } = req.user;

    const storyCheck = await db.query(
      'SELECT id FROM stories WHERE id = $1 AND project_id = $2',
      [storyId, projectId]
    );
    if (storyCheck.rows.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Story not found' } });
    }

    // Fetch test cases linked to this story — visible to the whole org
    let query, params;
    if (orgId) {
      query = `SELECT tc.id, tc.title, tc.content, tc.status, tc.priority,
                      tc.jira_issue_key AS "jiraIssueKey",
                      tc.created_at AS "createdAt", tc.user_id AS "createdBy",
                      u.email AS "createdByEmail"
               FROM test_cases tc
               JOIN users u ON u.id = tc.user_id
               WHERE tc.story_id = $1 AND tc.project_id = $2
               ORDER BY tc.created_at DESC`;
      params = [storyId, projectId];
    } else {
      query = `SELECT tc.id, tc.title, tc.content, tc.status, tc.priority,
                      tc.jira_issue_key AS "jiraIssueKey",
                      tc.created_at AS "createdAt", tc.user_id AS "createdBy",
                      u.email AS "createdByEmail"
               FROM test_cases tc
               JOIN users u ON u.id = tc.user_id
               WHERE tc.story_id = $1 AND tc.project_id = $2 AND tc.user_id = $3
               ORDER BY tc.created_at DESC`;
      params = [storyId, projectId, userId];
    }

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/projects/:projectId/stories/:storyId/manual-test-cases
router.post('/:storyId/manual-test-cases', authenticate, async (req, res, next) => {
  try {
    const { projectId, storyId } = req.params;
    const { id: userId } = req.user;
    const { title, content, priority } = req.body;

    if (!title || title.trim().length < 2) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Title is required' } });
    }
    if (!content || content.trim().length < 2) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Content is required' } });
    }

    const storyCheck = await db.query(
      'SELECT id FROM stories WHERE id = $1 AND project_id = $2',
      [storyId, projectId]
    );
    if (storyCheck.rows.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Story not found' } });
    }

    const userRow = await db.query('SELECT organization_id FROM users WHERE id = $1', [userId]);
    const organizationId = userRow.rows[0]?.organization_id || null;

    const result = await db.query(
      `INSERT INTO test_cases (project_id, user_id, title, content, priority, story_id, organization_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, title, content, status, priority,
                 jira_issue_key AS "jiraIssueKey",
                 created_at AS "createdAt", user_id AS "createdBy"`,
      [projectId, userId, title.trim(), content.trim(), priority || 'medium', storyId, organizationId]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/projects/:projectId/stories/:storyId/manual-test-cases/:tcId
router.delete('/:storyId/manual-test-cases/:tcId', authenticate, async (req, res, next) => {
  try {
    const { projectId, storyId, tcId } = req.params;
    const { id: userId } = req.user;

    const result = await db.query(
      'DELETE FROM test_cases WHERE id = $1 AND project_id = $2 AND story_id = $3 AND user_id = $4 RETURNING id',
      [tcId, projectId, storyId, userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Test case not found' } });
    }
    res.json({ message: 'Deleted' });
  } catch (err) {
    next(err);
  }
});

// POST /api/projects/:projectId/stories/:storyId/scenarios — manually add a scenario
router.post('/:storyId/scenarios', authenticate, async (req, res, next) => {
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

    const { category, title, summary, preconditions, test_intent, inputs, expected_outcome, priority } = req.body;

    const validCategories = ['happy_path', 'negative', 'edge', 'validation', 'role_permission', 'state_transition', 'api_impact', 'non_functional'];
    const validPriorities = ['P0', 'P1', 'P2', 'P3'];

    if (!category || !validCategories.includes(category)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Invalid category' } });
    }
    if (!title || title.trim().length < 5) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Title must be at least 5 characters' } });
    }
    if (!expected_outcome || expected_outcome.trim().length < 5) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Expected outcome is required' } });
    }
    if (!priority || !validPriorities.includes(priority)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Invalid priority' } });
    }

    const result = await db.query(
      `INSERT INTO scenarios (story_id, project_id, user_id, category, title, summary, preconditions, test_intent, inputs, expected_outcome, priority, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending')
       RETURNING *`,
      [
        storyId, projectId, userId,
        category, title.trim(),
        summary ? summary.trim() : '',
        JSON.stringify(Array.isArray(preconditions) ? preconditions : (preconditions ? [preconditions] : [])),
        test_intent ? test_intent.trim() : '',
        JSON.stringify(inputs && typeof inputs === 'object' ? inputs : {}),
        expected_outcome.trim(),
        priority,
      ]
    );

    res.status(201).json(result.rows[0]);
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

    // Quality score: 70% from category coverage + 30% from depth (avg scenarios per covered category)
    const categoryScore = (coveredCount / allCategories.length) * 70;
    let depthScore = 0;
    if (coveredCount > 0) {
      const coveredCats = allCategories.filter(c => byCategory[c]);
      const avgPerCat = coveredCats.reduce((sum, c) => sum + byCategory[c].total, 0) / coveredCats.length;
      depthScore = Math.min(avgPerCat / 3, 1) * 30;
    }
    const qualityScore = Math.min(Math.round(categoryScore + depthScore), 100);

    res.json({ total, approved, rejected, pending, byCategory, missingCategories, qualityScore, readyForExport: approved > 0 && pending === 0 });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
