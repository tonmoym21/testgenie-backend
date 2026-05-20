const { Router } = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { NotFoundError } = require('../utils/apiError');
const svc = require('../services/apiSourceService');
const logger = require('../utils/logger');

const router = Router();
router.use(authenticate);

// ── Validation schemas ──────────────────────────────────────────────────

const previewSchema = z.object({
  raw: z.string().optional(),
  url: z.string().url().optional(),
}).refine((d) => d.raw || d.url, { message: 'Provide raw or url' });

const ingestSchema = z.object({
  name: z.string().min(1).max(300).optional(),
  raw: z.string().optional(),
  url: z.string().url().optional(),
  refreshPolicy: z.object({
    mode: z.enum(['manual', 'cron', 'webhook']).default('manual'),
    cron: z.string().optional(),
  }).optional(),
}).refine((d) => d.raw || d.url, { message: 'Provide raw or url' });

const commitSchema = z.object({
  collectionId: z.number().int().positive(),
  endpointIds: z.array(z.number().int().positive()).min(1).max(500),
  authProfile: z.object({
    type: z.enum(['bearer', 'apiKey', 'none']),
    tokenVar: z.string().optional(),
    headerName: z.string().optional(),
  }).optional(),
});

// ── Routes ──────────────────────────────────────────────────────────────

// POST /api/sources/preview — paste-box live preview, no persistence
router.post('/preview', validate(previewSchema), async (req, res, next) => {
  try {
    const result = await svc.previewImport(req.body);
    res.json(result);
  } catch (err) {
    // Format-detection failures are expected user input errors; surface as 400.
    if (err.code === 'UNRECOGNISED_FORMAT' || err.code === 'UNKNOWN_JSON_FORMAT' || err.code === 'NO_ADAPTER') {
      return res.status(400).json({ error: { code: err.code, message: err.message } });
    }
    next(err);
  }
});

// POST /api/sources — full ingest. Persists source, version, endpoints.
router.post('/', validate(ingestSchema), async (req, res, next) => {
  try {
    const source = await svc.ingestSource(req.user, req.body);
    res.status(201).json(source);
  } catch (err) {
    if (err.code === 'UNRECOGNISED_FORMAT' || err.code === 'UNKNOWN_JSON_FORMAT') {
      return res.status(400).json({ error: { code: err.code, message: err.message } });
    }
    next(err);
  }
});

// GET /api/sources — list user/org sources
router.get('/', async (req, res, next) => {
  try {
    const rows = await svc.listSources(req.user);
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// GET /api/sources/:id — single source detail
router.get('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const source = await svc.getSource(req.user, id);
    if (!source) throw new NotFoundError('Source');
    res.json(source);
  } catch (err) { next(err); }
});

// GET /api/sources/:id/endpoints?method=&tag=&search=
router.get('/:id/endpoints', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const endpoints = await svc.listEndpoints(req.user, id, {
      method: req.query.method,
      tag: req.query.tag,
      search: req.query.search,
    });
    res.json({ data: endpoints });
  } catch (err) { next(err); }
});

// POST /api/sources/:id/refresh — re-fetch + diff
router.post('/:id/refresh', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const result = await svc.refreshSource(req.user, id);
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/sources/commit — selected endpoints → collection_tests rows
router.post('/commit', validate(commitSchema), async (req, res, next) => {
  try {
    const result = await svc.commitToCollection(req.user, req.body);
    res.status(201).json(result);
  } catch (err) { next(err); }
});

// DELETE /api/sources/:id — soft delete
router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    await svc.deleteSource(req.user, id);
    res.json({ message: 'Source archived' });
  } catch (err) { next(err); }
});

module.exports = router;
