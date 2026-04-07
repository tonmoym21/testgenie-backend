#!/usr/bin/env node
// setup-s2t.js — Writes all Story-to-CSV files into your project
const fs = require('fs');
const path = require('path');

const files = {};

// ============================================================================
// 1. MIGRATION
// ============================================================================
files['migrations/001_stories_and_scenarios.sql'] = `-- Migration: Story-to-CSV foundation tables
-- Run: psql $DATABASE_URL -f migrations/001_stories_and_scenarios.sql

CREATE TABLE IF NOT EXISTS stories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'text' CHECK (source_type IN ('text', 'url')),
  source_url TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'extracted', 'reviewed', 'exported')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scenarios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN (
    'happy_path', 'negative', 'edge', 'validation',
    'role_permission', 'state_transition', 'api_impact', 'non_functional'
  )),
  title TEXT NOT NULL,
  summary TEXT,
  preconditions JSONB DEFAULT '[]'::jsonb,
  test_intent TEXT,
  inputs JSONB DEFAULT '{}'::jsonb,
  expected_outcome TEXT,
  priority TEXT NOT NULL DEFAULT 'P1' CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stories_project_user ON stories(project_id, user_id);
CREATE INDEX IF NOT EXISTS idx_stories_project ON stories(project_id);
CREATE INDEX IF NOT EXISTS idx_scenarios_story ON scenarios(story_id);
CREATE INDEX IF NOT EXISTS idx_scenarios_story_status ON scenarios(story_id, status);
CREATE INDEX IF NOT EXISTS idx_scenarios_project ON scenarios(project_id);
`;

// ============================================================================
// 2. src/index.js
// ============================================================================
files['src/index.js'] = `require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const pinoHttp = require('pino-http');

const config = require('./config');
const logger = require('./utils/logger');
const { generalLimiter } = require('./middleware/rateLimiter');
const { errorHandler } = require('./middleware/errorHandler');

// Route imports
const healthRoutes = require('./routes/health');
const authRoutes = require('./routes/auth');
const projectRoutes = require('./routes/projects');
const storyRoutes = require('./routes/stories');
const testcaseRoutes = require('./routes/testcases');
const analyzeRoutes = require('./routes/analyze');
const executeRoutes = require('./routes/execute');
const reportsRoutes = require('./routes/reports');
const collectionsRoutes = require('./routes/collections');
const environmentsRoutes = require('./routes/environments');
const schedulesRoutes = require('./routes/schedules');

const app = express();

// Middleware stack
app.use(
  cors({
    origin: config.CORS_ORIGIN,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);
app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(
  pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) => req.url === '/health',
    },
  })
);
app.use(generalLimiter);

// Routes
app.use(healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/projects/:projectId/stories', storyRoutes);
app.use('/api/projects/:projectId/testcases', testcaseRoutes);
app.use('/api/projects/:projectId/analyze', analyzeRoutes);
app.use('/api', executeRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/collections', collectionsRoutes);
app.use('/api/environments', environmentsRoutes);
app.use('/api/schedules', schedulesRoutes);

// 404 catch-all
app.use((_req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'Route not found' },
  });
});

// Centralized error handler
app.use(errorHandler);

// Start server
if (require.main === module) {
  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, 'TestGenie API server started');
  });

  const shutdown = async (signal) => {
    logger.info({ signal }, 'Shutdown signal received');
    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = app;
`;

// ============================================================================
// 3. src/routes/stories.js
// ============================================================================
files['src/routes/stories.js'] = `const { Router } = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { scenarioToCsvRows } = require('../utils/csvTransformer');

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
      \`INSERT INTO stories (project_id, user_id, title, description, source_type, source_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *\`,
      [projectId, userId, title.trim(), description.trim(), sourceType || 'text', sourceUrl || null]
    );

    const story = result.rows[0];

    // Auto-generate draft scenarios
    const scenarios = generateDraftScenarios(story);
    if (scenarios.length > 0) {
      const values = [];
      const placeholders = [];
      let idx = 1;
      for (const s of scenarios) {
        placeholders.push(
          \`($\${idx++}, $\${idx++}, $\${idx++}, $\${idx++}, $\${idx++}, $\${idx++}, $\${idx++}, $\${idx++}, $\${idx++}, $\${idx++})\`
        );
        values.push(
          story.id, projectId, userId,
          s.category, s.title, s.summary,
          JSON.stringify(s.preconditions), s.test_intent,
          s.expected_outcome, s.priority
        );
      }
      await db.query(
        \`INSERT INTO scenarios (story_id, project_id, user_id, category, title, summary, preconditions, test_intent, expected_outcome, priority)
         VALUES \${placeholders.join(', ')}\`,
        values
      );
      await db.query(
        \`UPDATE stories SET status = 'extracted', updated_at = NOW() WHERE id = $1\`,
        [story.id]
      );
      story.status = 'extracted';
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
      \`SELECT s.*,
        (SELECT count(*) FROM scenarios sc WHERE sc.story_id = s.id)::int AS scenario_count,
        (SELECT count(*) FROM scenarios sc WHERE sc.story_id = s.id AND sc.status = 'approved')::int AS approved_count
       FROM stories s
       WHERE s.project_id = $1 AND s.user_id = $2
       ORDER BY s.created_at DESC\`,
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
      \`SELECT * FROM scenarios WHERE story_id = $1 ORDER BY
        CASE category
          WHEN 'happy_path' THEN 1 WHEN 'negative' THEN 2
          WHEN 'edge' THEN 3 WHEN 'validation' THEN 4
          WHEN 'role_permission' THEN 5 WHEN 'state_transition' THEN 6
          WHEN 'api_impact' THEN 7 WHEN 'non_functional' THEN 8
        END, created_at\`,
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
      \`UPDATE scenarios SET status = $1, review_note = $2, updated_at = NOW()
       WHERE id = $3 AND story_id = $4 RETURNING *\`,
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
      \`SELECT id, category, title, summary, preconditions, test_intent,
              inputs, expected_outcome, priority
       FROM scenarios
       WHERE story_id = $1 AND status = 'approved'
       ORDER BY
         CASE category
           WHEN 'happy_path' THEN 1 WHEN 'negative' THEN 2
           WHEN 'edge' THEN 3 WHEN 'validation' THEN 4
           WHEN 'role_permission' THEN 5 WHEN 'state_transition' THEN 6
           WHEN 'api_impact' THEN 7 WHEN 'non_functional' THEN 8
         END, created_at\`,
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
      \`SELECT category, status, count(*)::int AS count
       FROM scenarios WHERE story_id = $1
       GROUP BY category, status\`,
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

// Draft scenario generator (rule-based V1 placeholder)
function generateDraftScenarios(story) {
  const title = story.title || 'Feature';
  return [
    { category: 'happy_path', title: title + ' - successful primary flow', summary: 'Verify the main success path for: ' + title, preconditions: ['User is logged in', 'Required data is available'], test_intent: 'Validate the core happy path works as described', expected_outcome: 'Feature completes successfully as per acceptance criteria', priority: 'P0' },
    { category: 'happy_path', title: title + ' - successful with all optional fields', summary: 'Verify feature works when all optional inputs are provided', preconditions: ['User is logged in'], test_intent: 'Validate full input acceptance', expected_outcome: 'Feature handles all optional fields correctly', priority: 'P1' },
    { category: 'negative', title: title + ' - missing required input', summary: 'Verify error handling when required fields are empty', preconditions: ['User is logged in'], test_intent: 'Validate proper error messages for missing data', expected_outcome: 'System shows validation error, does not proceed', priority: 'P0' },
    { category: 'negative', title: title + ' - unauthorized access attempt', summary: 'Verify feature blocks unauthenticated users', preconditions: ['User is NOT logged in'], test_intent: 'Validate auth guard prevents unauthorized access', expected_outcome: 'System redirects to login or shows 401 error', priority: 'P1' },
    { category: 'validation', title: title + ' - invalid input format', summary: 'Verify system rejects malformed or out-of-range input', preconditions: ['User is logged in'], test_intent: 'Validate input sanitization and format checking', expected_outcome: 'System shows field-level validation errors', priority: 'P1' },
    { category: 'edge', title: title + ' - boundary value handling', summary: 'Verify behavior at min/max boundaries of inputs', preconditions: ['User is logged in'], test_intent: 'Validate edge cases at input boundaries', expected_outcome: 'System handles boundary values correctly without errors', priority: 'P2' },
    { category: 'role_permission', title: title + ' - role-based access control', summary: 'Verify different user roles have correct access levels', preconditions: ['Multiple user roles exist'], test_intent: 'Validate permissions are enforced per role', expected_outcome: 'Unauthorized roles are blocked, authorized roles succeed', priority: 'P1' },
    { category: 'api_impact', title: title + ' - API response handling', summary: 'Verify correct handling of API success and failure responses', preconditions: ['Backend API is available'], test_intent: 'Validate frontend handles API states (loading, success, error)', expected_outcome: 'UI reflects API state correctly', priority: 'P2' },
  ];
}

module.exports = router;
`;

// ============================================================================
// 4. src/utils/csvTransformer.js
// ============================================================================
files['src/utils/csvTransformer.js'] = `// src/utils/csvTransformer.js
const PRIORITY_MAP = { P0: 'critical', P1: 'high', P2: 'medium', P3: 'low' };

const CATEGORY_TAGS = {
  happy_path: ['smoke', 'regression'],
  negative: ['regression', 'error-handling'],
  edge: ['regression', 'boundary'],
  validation: ['regression', 'data-validation'],
  role_permission: ['regression', 'security', 'access-control'],
  state_transition: ['regression', 'state-management'],
  api_impact: ['regression', 'api', 'integration'],
  non_functional: ['regression', 'performance'],
};

function escapeCsvField(value) {
  if (value === null || value === undefined) return '""';
  const str = String(value).trim();
  if (str === '') return '""';
  const escaped = str.replace(/"/g, '""');
  return '"' + escaped + '"';
}

function scenarioToCsvRows(scenarios, storyTitle) {
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    throw new Error('No scenarios provided for CSV export');
  }

  const header = 'TestCaseID,Title,Preconditions,Step1,Step2,Step3,ExpectedResult,Priority,Tags';
  const lines = [header];

  scenarios.forEach((s, index) => {
    const tcId = 'TC' + String(index + 1).padStart(3, '0');
    const priority = PRIORITY_MAP[s.priority] || 'medium';
    const tags = (CATEGORY_TAGS[s.category] || ['regression']).join(', ');

    let preconditions = '';
    if (Array.isArray(s.preconditions)) {
      preconditions = s.preconditions.filter(Boolean).join(' | ');
    } else if (typeof s.preconditions === 'string') {
      try {
        const parsed = JSON.parse(s.preconditions);
        preconditions = Array.isArray(parsed) ? parsed.filter(Boolean).join(' | ') : s.preconditions;
      } catch (e) {
        preconditions = s.preconditions;
      }
    }

    const step1 = deriveSetupStep(s);
    const step2 = deriveActionStep(s);
    const step3 = deriveVerifyStep(s);
    const expectedResult = s.expected_outcome || s.expectedOutcome || '';

    const row = [tcId, s.title || '', preconditions, step1, step2, step3, expectedResult, priority, tags]
      .map(escapeCsvField).join(',');
    lines.push(row);
  });

  return lines.join('\\n');
}

function testCaseToCsvRows(testCases) {
  if (!Array.isArray(testCases) || testCases.length === 0) {
    throw new Error('No test cases provided for CSV export');
  }

  const header = 'TestCaseID,Title,Category,Preconditions,Step1,Step2,Step3,ExpectedResult,Priority,Tags,Notes';
  const lines = [header];

  testCases.forEach((tc, index) => {
    const tcId = 'TC' + String(index + 1).padStart(3, '0');
    const priority = PRIORITY_MAP[tc.priority] || tc.priority || 'high';
    const tags = (CATEGORY_TAGS[tc.category] || ['regression']).join(', ');

    let preconditions = '';
    if (Array.isArray(tc.preconditions)) {
      preconditions = tc.preconditions.filter(Boolean).join(' | ');
    } else if (typeof tc.preconditions === 'string') {
      preconditions = tc.preconditions;
    }

    let step1 = '', step2 = '', step3 = '';
    if (Array.isArray(tc.steps)) {
      tc.steps.forEach((stepObj, idx) => {
        const text = (stepObj.step || idx + 1) + '. ' + (stepObj.action || '');
        if (idx === 0) step1 = text;
        else if (idx === 1) step2 = text;
        else if (idx === 2) step3 = text;
      });
    }

    const row = [tcId, tc.title || '', tc.category || 'general', preconditions, step1, step2, step3, tc.expected_result || '', priority, tags, tc.notes || '']
      .map(escapeCsvField).join(',');
    lines.push(row);
  });

  return lines.join('\\n');
}

function deriveSetupStep(scenario) {
  const pre = scenario.preconditions;
  if (Array.isArray(pre) && pre.length > 0 && pre[0]) return String(pre[0]).substring(0, 200);
  if (typeof pre === 'string') {
    try {
      const parsed = JSON.parse(pre);
      if (Array.isArray(parsed) && parsed[0]) return String(parsed[0]).substring(0, 200);
    } catch (e) { /* fallback */ }
  }
  const intent = (scenario.test_intent || '').toLowerCase();
  if (intent.includes('login')) return 'Navigate to login page';
  if (intent.includes('create')) return 'Open create form';
  if (intent.includes('delete')) return 'Locate item to delete';
  return 'Perform initial setup';
}

function deriveActionStep(scenario) {
  const inputs = scenario.inputs;
  if (inputs && typeof inputs === 'object' && !Array.isArray(inputs)) {
    const entries = Object.entries(inputs)
      .filter(function(e) { return e[1] !== null && e[1] !== undefined; })
      .slice(0, 2)
      .map(function(e) { return e[0] + ': "' + e[1] + '"'; });
    if (entries.length > 0) return 'Enter test data (' + entries.join(', ') + ')';
  }
  const intent = (scenario.test_intent || '').toLowerCase();
  if (intent.includes('submit')) return 'Click Submit button';
  if (intent.includes('save')) return 'Click Save button';
  if (intent.includes('login')) return 'Enter credentials and click Login';
  return 'Execute the primary action under test';
}

function deriveVerifyStep(scenario) {
  const outcome = scenario.expected_outcome || '';
  if (!outcome) return 'Verify action completed successfully';
  return 'Verify: ' + outcome.substring(0, 150);
}

module.exports = { scenarioToCsvRows, testCaseToCsvRows, escapeCsvField, PRIORITY_MAP, CATEGORY_TAGS };
`;

// ============================================================================
// 5. frontend/services/storyApi.js
// ============================================================================
files['frontend/services/storyApi.js'] = `// frontend/services/storyApi.js
const API_BASE = window.location.hostname === 'localhost' ? 'http://localhost:3000' : '';

function getHeaders() {
  const token = localStorage.getItem('accessToken') || localStorage.getItem('authToken');
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: 'Bearer ' + token } : {}),
  };
}

async function handleResponse(res) {
  if (!res.ok) {
    const body = await res.json().catch(function() { return { error: { message: res.statusText } }; });
    throw new Error((body.error && body.error.message) || body.message || 'Request failed: ' + res.status);
  }
  return res;
}

export async function listStories(projectId) {
  const res = await fetch(API_BASE + '/api/projects/' + projectId + '/stories', { headers: getHeaders() });
  await handleResponse(res);
  return res.json();
}

export async function getStory(projectId, storyId) {
  const res = await fetch(API_BASE + '/api/projects/' + projectId + '/stories/' + storyId, { headers: getHeaders() });
  await handleResponse(res);
  return res.json();
}

export async function createStory(projectId, data) {
  const res = await fetch(API_BASE + '/api/projects/' + projectId + '/stories', {
    method: 'POST', headers: getHeaders(), body: JSON.stringify(data),
  });
  await handleResponse(res);
  return res.json();
}

export async function deleteStory(projectId, storyId) {
  const res = await fetch(API_BASE + '/api/projects/' + projectId + '/stories/' + storyId, {
    method: 'DELETE', headers: getHeaders(),
  });
  await handleResponse(res);
  return res.json();
}

export async function listScenarios(projectId, storyId) {
  const res = await fetch(API_BASE + '/api/projects/' + projectId + '/stories/' + storyId + '/scenarios', { headers: getHeaders() });
  await handleResponse(res);
  return res.json();
}

export async function updateScenarioStatus(projectId, storyId, scenarioId, status, reviewNote) {
  const res = await fetch(
    API_BASE + '/api/projects/' + projectId + '/stories/' + storyId + '/scenarios/' + scenarioId,
    { method: 'PATCH', headers: getHeaders(), body: JSON.stringify({ status: status, reviewNote: reviewNote }) }
  );
  await handleResponse(res);
  return res.json();
}

export async function getCoverage(projectId, storyId) {
  const res = await fetch(API_BASE + '/api/projects/' + projectId + '/stories/' + storyId + '/coverage', { headers: getHeaders() });
  await handleResponse(res);
  return res.json();
}

export async function exportStoryCsv(projectId, storyId) {
  const token = localStorage.getItem('accessToken') || localStorage.getItem('authToken');
  const res = await fetch(
    API_BASE + '/api/projects/' + projectId + '/stories/' + storyId + '/export-csv',
    { method: 'POST', headers: { Authorization: 'Bearer ' + token } }
  );
  if (!res.ok) {
    const body = await res.json().catch(function() { return { error: { message: 'Export failed' } }; });
    throw new Error((body.error && body.error.message) || 'Export failed');
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') || '';
  const filenameMatch = disposition.match(/filename="?([^"]+)"?/);
  const filename = filenameMatch ? filenameMatch[1] : 'story-export-' + Date.now() + '.csv';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
  return { filename: filename };
}
`;

// ============================================================================
// 6. frontend/pages/StoriesPage.jsx
// ============================================================================
files['frontend/pages/StoriesPage.jsx'] = `import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { listStories, deleteStory } from '../services/storyApi';

export default function StoriesPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [stories, setStories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(function() { loadStories(); }, [projectId]);

  async function loadStories() {
    try {
      setLoading(true); setError(null);
      const data = await listStories(projectId);
      setStories(data);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }

  async function handleDelete(storyId) {
    if (!window.confirm('Delete this story and all its scenarios?')) return;
    try {
      await deleteStory(projectId, storyId);
      setStories(function(prev) { return prev.filter(function(s) { return s.id !== storyId; }); });
    } catch (err) { alert('Failed to delete: ' + err.message); }
  }

  var statusColors = { draft: '#6b7280', extracted: '#2563eb', reviewed: '#16a34a', exported: '#7c3aed' };

  if (loading) return React.createElement('div', { style: { textAlign: 'center', padding: '40px', color: '#6b7280' } }, 'Loading stories...');
  if (error) return React.createElement('div', { style: { textAlign: 'center', padding: '40px', color: '#dc2626' } }, 'Error: ' + error);

  return React.createElement('div', { style: { maxWidth: '800px', margin: '0 auto', padding: '24px' } },
    React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' } },
      React.createElement('div', null,
        React.createElement(Link, { to: '/projects/' + projectId, style: { color: '#2563eb', textDecoration: 'none', fontSize: '14px' } }, '\\u2190 Back to Project'),
        React.createElement('h1', { style: { fontSize: '24px', fontWeight: '700', margin: '8px 0 4px' } }, 'User Stories'),
        React.createElement('p', { style: { color: '#6b7280', fontSize: '14px', margin: 0 } }, 'Submit user stories to generate test scenarios and export CSV')
      ),
      React.createElement('button', {
        style: { backgroundColor: '#2563eb', color: '#fff', border: 'none', borderRadius: '6px', padding: '10px 18px', fontSize: '14px', fontWeight: '600', cursor: 'pointer' },
        onClick: function() { navigate('/projects/' + projectId + '/stories/new'); }
      }, '+ New Story')
    ),
    stories.length === 0
      ? React.createElement('div', { style: { textAlign: 'center', padding: '60px 20px', backgroundColor: '#f9fafb', borderRadius: '8px', border: '1px dashed #d1d5db' } },
          React.createElement('p', { style: { fontSize: '18px', marginBottom: '8px' } }, 'No stories yet'),
          React.createElement('p', { style: { color: '#6b7280' } }, 'Create your first user story to start generating test scenarios.'),
          React.createElement('button', {
            style: { backgroundColor: '#2563eb', color: '#fff', border: 'none', borderRadius: '6px', padding: '10px 18px', fontSize: '14px', fontWeight: '600', cursor: 'pointer', marginTop: '16px' },
            onClick: function() { navigate('/projects/' + projectId + '/stories/new'); }
          }, '+ Create First Story')
        )
      : React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
          stories.map(function(story) {
            return React.createElement('div', {
              key: story.id,
              style: { backgroundColor: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '16px', cursor: 'pointer' },
              onClick: function() { navigate('/projects/' + projectId + '/stories/' + story.id); }
            },
              React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' } },
                React.createElement('h3', { style: { fontSize: '16px', fontWeight: '600', margin: 0 } }, story.title),
                React.createElement('span', { style: { color: '#fff', fontSize: '11px', padding: '2px 8px', borderRadius: '9999px', fontWeight: '600', backgroundColor: statusColors[story.status] || '#6b7280' } }, story.status)
              ),
              React.createElement('p', { style: { color: '#4b5563', fontSize: '14px', margin: '0 0 12px', lineHeight: '1.5' } },
                (story.description || '').substring(0, 150) + (story.description && story.description.length > 150 ? '...' : '')
              ),
              React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                React.createElement('span', { style: { color: '#9ca3af', fontSize: '12px' } },
                  (story.scenario_count || 0) + ' scenarios' + (story.approved_count > 0 ? ' \\u00B7 ' + story.approved_count + ' approved' : '')
                ),
                React.createElement('div', { style: { display: 'flex', gap: '8px' } },
                  React.createElement('span', { style: { color: '#9ca3af', fontSize: '12px' } }, new Date(story.created_at).toLocaleDateString()),
                  React.createElement('button', {
                    style: { background: 'none', border: 'none', color: '#9ca3af', fontSize: '18px', cursor: 'pointer', padding: '0 4px', lineHeight: '1' },
                    onClick: function(e) { e.stopPropagation(); handleDelete(story.id); }
                  }, '\\u00D7')
                )
              )
            );
          })
        )
  );
}
`;

// ============================================================================
// 7. frontend/pages/CreateStoryPage.jsx
// ============================================================================
files['frontend/pages/CreateStoryPage.jsx'] = `import React, { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { createStory } from '../services/storyApi';

export default function CreateStoryPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [sourceType, setSourceType] = useState('text');
  const [sourceUrl, setSourceUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!title.trim()) return setError('Title is required');
    if (description.trim().length < 20) return setError('Description must be at least 20 characters');
    try {
      setSubmitting(true); setError(null);
      var story = await createStory(projectId, {
        title: title.trim(), description: description.trim(),
        sourceType: sourceType, sourceUrl: sourceType === 'url' ? sourceUrl.trim() : null,
      });
      navigate('/projects/' + projectId + '/stories/' + story.id);
    } catch (err) { setError(err.message); }
    finally { setSubmitting(false); }
  }

  var inputStyle = { padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '14px', outline: 'none', width: '100%', boxSizing: 'border-box' };

  return React.createElement('div', { style: { maxWidth: '700px', margin: '0 auto', padding: '24px' } },
    React.createElement(Link, { to: '/projects/' + projectId + '/stories', style: { color: '#2563eb', textDecoration: 'none', fontSize: '14px' } }, '\\u2190 Back to Stories'),
    React.createElement('h1', { style: { fontSize: '24px', fontWeight: '700', margin: '8px 0 4px' } }, 'New User Story'),
    React.createElement('p', { style: { color: '#6b7280', fontSize: '14px', margin: '0 0 24px' } }, 'Paste a user story or feature description. The system will generate test scenarios automatically.'),

    React.createElement('form', { onSubmit: handleSubmit, style: { display: 'flex', flexDirection: 'column', gap: '20px' } },
      error && React.createElement('div', { style: { backgroundColor: '#fef2f2', color: '#dc2626', padding: '12px', borderRadius: '6px', border: '1px solid #fecaca', fontSize: '14px' } }, error),

      React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '14px', fontWeight: '500' } },
        'Title *',
        React.createElement('input', { type: 'text', value: title, onChange: function(e) { setTitle(e.target.value); }, placeholder: 'e.g. User Login with Email and Password', style: inputStyle, maxLength: 256 })
      ),

      React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '14px', fontWeight: '500' } },
        'Story Description *',
        React.createElement('textarea', { value: description, onChange: function(e) { setDescription(e.target.value); }, placeholder: 'Paste the full user story here including acceptance criteria...', style: Object.assign({}, inputStyle, { fontFamily: 'inherit', resize: 'vertical', minHeight: '200px' }), maxLength: 10240 }),
        React.createElement('span', { style: { fontSize: '12px', color: '#9ca3af', textAlign: 'right' } }, description.length + '/10,240 characters (min 20)')
      ),

      React.createElement('div', { style: { display: 'flex', gap: '16px', alignItems: 'flex-end' } },
        React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '14px', fontWeight: '500' } },
          'Source',
          React.createElement('select', { value: sourceType, onChange: function(e) { setSourceType(e.target.value); }, style: inputStyle },
            React.createElement('option', { value: 'text' }, 'Pasted Text'),
            React.createElement('option', { value: 'url' }, 'URL (Jira/GitHub/etc.)')
          )
        ),
        sourceType === 'url' && React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '14px', fontWeight: '500', flex: 2 } },
          'Source URL',
          React.createElement('input', { type: 'url', value: sourceUrl, onChange: function(e) { setSourceUrl(e.target.value); }, placeholder: 'https://jira.example.com/browse/PROJ-123', style: inputStyle })
        )
      ),

      React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '12px', paddingTop: '12px' } },
        React.createElement('button', { type: 'button', onClick: function() { navigate('/projects/' + projectId + '/stories'); }, style: { padding: '10px 18px', border: '1px solid #d1d5db', borderRadius: '6px', backgroundColor: '#fff', fontSize: '14px', cursor: 'pointer' } }, 'Cancel'),
        React.createElement('button', { type: 'submit', disabled: submitting, style: { padding: '10px 18px', border: 'none', borderRadius: '6px', backgroundColor: '#2563eb', color: '#fff', fontSize: '14px', fontWeight: '600', cursor: 'pointer' } }, submitting ? 'Creating...' : 'Create Story & Generate Scenarios')
      )
    )
  );
}
`;

// ============================================================================
// 8. frontend/pages/StoryDetailPage.jsx
// ============================================================================
files['frontend/pages/StoryDetailPage.jsx'] = `import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getStory, listScenarios, updateScenarioStatus, getCoverage, exportStoryCsv } from '../services/storyApi';

var CATEGORY_LABELS = {
  happy_path: 'Happy Path', negative: 'Negative', edge: 'Edge Cases', validation: 'Validation',
  role_permission: 'Role / Permission', state_transition: 'State Transition', api_impact: 'API Impact', non_functional: 'Non-Functional',
};

export default function StoryDetailPage() {
  var params = useParams();
  var projectId = params.projectId, storyId = params.storyId;
  var [story, setStory] = useState(null);
  var [scenarios, setScenarios] = useState([]);
  var [coverage, setCoverage] = useState(null);
  var [loading, setLoading] = useState(true);
  var [error, setError] = useState(null);
  var [exporting, setExporting] = useState(false);
  var [exportMsg, setExportMsg] = useState(null);

  var loadData = useCallback(async function() {
    try {
      setLoading(true); setError(null);
      var results = await Promise.all([getStory(projectId, storyId), listScenarios(projectId, storyId), getCoverage(projectId, storyId)]);
      setStory(results[0]); setScenarios(results[1]); setCoverage(results[2]);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, [projectId, storyId]);

  useEffect(function() { loadData(); }, [loadData]);

  async function handleStatusChange(scenarioId, newStatus) {
    try {
      var updated = await updateScenarioStatus(projectId, storyId, scenarioId, newStatus);
      setScenarios(function(prev) { return prev.map(function(s) { return s.id === scenarioId ? updated : s; }); });
      var cov = await getCoverage(projectId, storyId);
      setCoverage(cov);
    } catch (err) { alert('Failed: ' + err.message); }
  }

  async function handleBulkAction(category, newStatus) {
    var targets = scenarios.filter(function(s) { return s.category === category && s.status !== newStatus; });
    for (var i = 0; i < targets.length; i++) {
      await handleStatusChange(targets[i].id, newStatus);
    }
  }

  async function handleExport() {
    try {
      setExporting(true); setExportMsg(null);
      var result = await exportStoryCsv(projectId, storyId);
      setExportMsg('Downloaded: ' + result.filename);
    } catch (err) { setExportMsg('Error: ' + err.message); }
    finally { setExporting(false); }
  }

  if (loading) return React.createElement('div', { style: { textAlign: 'center', padding: '40px', color: '#6b7280' } }, 'Loading story...');
  if (error) return React.createElement('div', { style: { textAlign: 'center', padding: '40px', color: '#dc2626' } }, 'Error: ' + error);
  if (!story) return React.createElement('div', { style: { textAlign: 'center', padding: '40px', color: '#6b7280' } }, 'Story not found');

  var approvedCount = scenarios.filter(function(s) { return s.status === 'approved'; }).length;
  var pendingCount = scenarios.filter(function(s) { return s.status === 'pending'; }).length;
  var rejectedCount = scenarios.filter(function(s) { return s.status === 'rejected'; }).length;
  var canExport = approvedCount > 0;

  var grouped = {};
  scenarios.forEach(function(s) {
    if (!grouped[s.category]) grouped[s.category] = [];
    grouped[s.category].push(s);
  });

  return React.createElement('div', { style: { maxWidth: '800px', margin: '0 auto', padding: '24px' } },
    React.createElement(Link, { to: '/projects/' + projectId + '/stories', style: { color: '#2563eb', textDecoration: 'none', fontSize: '14px' } }, '\\u2190 Back to Stories'),
    React.createElement('h1', { style: { fontSize: '22px', fontWeight: '700', margin: '8px 0 4px' } }, story.title),
    React.createElement('p', { style: { color: '#4b5563', fontSize: '14px', margin: '0 0 20px', lineHeight: '1.6', whiteSpace: 'pre-wrap' } }, story.description),

    // Summary bar
    React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#f9fafb', borderRadius: '8px', padding: '16px 20px', border: '1px solid #e5e7eb', marginBottom: '16px' } },
      React.createElement('div', { style: { display: 'flex', gap: '24px' } },
        StatBox('Total', scenarios.length, '#374151'),
        StatBox('Approved', approvedCount, '#16a34a'),
        StatBox('Pending', pendingCount, '#d97706'),
        StatBox('Rejected', rejectedCount, '#dc2626'),
        coverage && StatBox('Quality', coverage.qualityScore + '%', '#7c3aed')
      ),
      React.createElement('button', {
        style: { backgroundColor: '#16a34a', color: '#fff', border: 'none', borderRadius: '6px', padding: '10px 18px', fontSize: '14px', fontWeight: '600', opacity: canExport && !exporting ? 1 : 0.5, cursor: canExport && !exporting ? 'pointer' : 'not-allowed' },
        disabled: !canExport || exporting,
        onClick: handleExport
      }, exporting ? 'Exporting...' : '\\u2B07 Export CSV (' + approvedCount + ')')
    ),

    // Export message
    exportMsg && React.createElement('div', {
      style: { padding: '10px 14px', borderRadius: '6px', fontSize: '13px', border: '1px solid', marginBottom: '16px',
        backgroundColor: exportMsg.indexOf('Error') === 0 ? '#fef2f2' : '#f0fdf4',
        color: exportMsg.indexOf('Error') === 0 ? '#dc2626' : '#16a34a',
        borderColor: exportMsg.indexOf('Error') === 0 ? '#fecaca' : '#bbf7d0' }
    }, exportMsg),

    // Missing categories warning
    coverage && coverage.missingCategories.length > 0 && React.createElement('div', {
      style: { backgroundColor: '#fffbeb', color: '#92400e', padding: '10px 14px', borderRadius: '6px', border: '1px solid #fcd34d', fontSize: '13px', marginBottom: '16px' }
    }, '\\u26A0 Missing coverage: ' + coverage.missingCategories.map(function(c) { return CATEGORY_LABELS[c] || c; }).join(', ')),

    // Scenario groups
    Object.entries(grouped).map(function(entry) {
      var category = entry[0], items = entry[1];
      return React.createElement('div', { key: category, style: { marginBottom: '24px' } },
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '2px solid #e5e7eb', paddingBottom: '8px', marginBottom: '12px' } },
          React.createElement('h2', { style: { fontSize: '16px', fontWeight: '600', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' } },
            CATEGORY_LABELS[category] || category,
            React.createElement('span', { style: { backgroundColor: '#e5e7eb', color: '#374151', fontSize: '12px', padding: '1px 8px', borderRadius: '9999px', fontWeight: '500' } }, items.length)
          ),
          React.createElement('div', { style: { display: 'flex', gap: '8px' } },
            React.createElement('button', { style: { background: 'none', border: '1px solid #d1d5db', borderRadius: '4px', padding: '4px 10px', fontSize: '12px', cursor: 'pointer', color: '#16a34a' }, onClick: function() { handleBulkAction(category, 'approved'); } }, '\\u2713 Approve All'),
            React.createElement('button', { style: { background: 'none', border: '1px solid #d1d5db', borderRadius: '4px', padding: '4px 10px', fontSize: '12px', cursor: 'pointer', color: '#dc2626' }, onClick: function() { handleBulkAction(category, 'rejected'); } }, '\\u2715 Reject All')
          )
        ),
        items.map(function(scenario) { return ScenarioCard(scenario, handleStatusChange); })
      );
    }),

    scenarios.length === 0 && React.createElement('div', { style: { textAlign: 'center', padding: '40px', color: '#6b7280', backgroundColor: '#f9fafb', borderRadius: '8px' } }, 'No scenarios generated for this story.')
  );
}

function StatBox(label, value, color) {
  return React.createElement('div', { style: { textAlign: 'center' } },
    React.createElement('div', { style: { fontSize: '20px', fontWeight: '700', color: color } }, value),
    React.createElement('div', { style: { fontSize: '11px', color: '#6b7280', textTransform: 'uppercase' } }, label)
  );
}

function ScenarioCard(scenario, onStatusChange) {
  var s = scenario;
  var statusConfig = {
    pending: { bg: '#fef3c7', color: '#92400e', label: 'Pending' },
    approved: { bg: '#dcfce7', color: '#166534', label: 'Approved' },
    rejected: { bg: '#fee2e2', color: '#991b1b', label: 'Rejected' },
  };
  var cfg = statusConfig[s.status] || statusConfig.pending;
  var priorityColors = { P0: '#dc2626', P1: '#d97706', P2: '#2563eb', P3: '#6b7280' };

  var preconditions = [];
  if (Array.isArray(s.preconditions)) { preconditions = s.preconditions; }
  else if (typeof s.preconditions === 'string') {
    try { preconditions = JSON.parse(s.preconditions); } catch(e) { preconditions = [s.preconditions]; }
  }

  var btnBase = { width: '28px', height: '28px', borderRadius: '4px', fontSize: '14px', cursor: 'pointer' };

  return React.createElement('div', { key: s.id, style: { backgroundColor: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '14px', marginBottom: '8px' } },
    React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' } },
      React.createElement('div', { style: { flex: 1 } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' } },
          React.createElement('span', { style: { fontSize: '11px', padding: '2px 8px', borderRadius: '9999px', fontWeight: '600', backgroundColor: cfg.bg, color: cfg.color } }, cfg.label),
          React.createElement('span', { style: { fontSize: '11px', fontWeight: '700', color: priorityColors[s.priority] || '#6b7280' } }, s.priority)
        ),
        React.createElement('h3', { style: { fontSize: '14px', fontWeight: '600', margin: '0 0 2px' } }, s.title),
        s.summary && React.createElement('p', { style: { fontSize: '13px', color: '#6b7280', margin: 0, lineHeight: '1.4' } }, s.summary)
      ),
      React.createElement('div', { style: { display: 'flex', gap: '4px', flexShrink: 0 } },
        s.status !== 'approved' && React.createElement('button', {
          style: Object.assign({}, btnBase, { border: '1px solid #bbf7d0', backgroundColor: '#dcfce7', color: '#16a34a' }),
          onClick: function() { onStatusChange(s.id, 'approved'); }, title: 'Approve'
        }, '\\u2713'),
        s.status !== 'rejected' && React.createElement('button', {
          style: Object.assign({}, btnBase, { border: '1px solid #fecaca', backgroundColor: '#fee2e2', color: '#dc2626' }),
          onClick: function() { onStatusChange(s.id, 'rejected'); }, title: 'Reject'
        }, '\\u2715'),
        s.status !== 'pending' && React.createElement('button', {
          style: Object.assign({}, btnBase, { border: '1px solid #e5e7eb', backgroundColor: '#f3f4f6', color: '#6b7280' }),
          onClick: function() { onStatusChange(s.id, 'pending'); }, title: 'Reset to Pending'
        }, '\\u21BA')
      )
    ),
    // Details section
    React.createElement('div', { style: { marginTop: '10px', paddingTop: '10px', borderTop: '1px solid #f3f4f6', fontSize: '13px', color: '#374151' } },
      s.test_intent && React.createElement('div', { style: { marginBottom: '6px' } }, React.createElement('strong', null, 'Test Intent: '), s.test_intent),
      preconditions.length > 0 && React.createElement('div', { style: { marginBottom: '6px' } },
        React.createElement('strong', null, 'Preconditions: '),
        preconditions.join(' | ')
      ),
      s.expected_outcome && React.createElement('div', { style: { marginBottom: '6px' } }, React.createElement('strong', null, 'Expected: '), s.expected_outcome)
    )
  );
}
`;

// ============================================================================
// WRITE ALL FILES
// ============================================================================
let created = 0;
Object.entries(files).forEach(([filePath, content]) => {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, content, 'utf8');
  const size = Buffer.byteLength(content, 'utf8');
  console.log(`  Created: ${filePath} (${size} bytes)`);
  created++;
});

console.log(`\n  All ${created} files created successfully.`);
console.log('\n  NEXT STEPS:');
console.log('  1. Run migration: psql %DATABASE_URL% -f migrations/001_stories_and_scenarios.sql');
console.log('  2. Merge story routes into frontend/App.jsx');
console.log('  3. npm start');
