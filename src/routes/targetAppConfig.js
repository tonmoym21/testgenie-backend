// src/routes/targetAppConfig.js
// CRUD routes for target application configuration
// Mounted at: /api/projects/:projectId/target-app

const { Router } = require('express');
const { z } = require('zod');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const targetAppConfigService = require('../services/targetAppConfigService');

const router = Router({ mergeParams: true });
router.use(authenticate);

const createSchema = z.object({
  name: z.string().min(1).max(128).default('Default'),
  baseUrl: z.string().url(),
  environment: z.enum(['local', 'staging', 'production', 'test']).default('staging'),
  authType: z.enum(['none', 'form_login', 'token', 'cookie', 'storage_state', 'basic_auth']).default('none'),
  loginUrl: z.string().url().optional(),
  authUsernameEnv: z.string().max(128).optional(),
  authPasswordEnv: z.string().max(128).optional(),
  authTokenEnv: z.string().max(128).optional(),
  storageStatePath: z.string().max(512).optional(),
  selectorStrategy: z.enum(['role_first', 'testid_first', 'label_first', 'css_fallback']).default('role_first'),
  selectorMap: z.record(z.string()).optional(),
  knownTestids: z.array(z.string()).optional(),
  isDefault: z.boolean().default(true),
});

router.post('/', validate(createSchema), async (req, res, next) => {
  try {
    const config = await targetAppConfigService.create({
      projectId: parseInt(req.params.projectId, 10),
      userId: req.user.id,
      ...req.body,
    });
    res.status(201).json(config);
  } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
  try {
    const configs = await targetAppConfigService.list(parseInt(req.params.projectId, 10), req.user.id);
    res.json(configs);
  } catch (err) { next(err); }
});

router.get('/:configId', async (req, res, next) => {
  try {
    const config = await targetAppConfigService.get(parseInt(req.params.configId, 10), req.user.id);
    if (!config) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Target app config not found' } });
    res.json(config);
  } catch (err) { next(err); }
});

const updateSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  base_url: z.string().url().optional(),
  environment: z.enum(['local', 'staging', 'production', 'test']).optional(),
  auth_type: z.enum(['none', 'form_login', 'token', 'cookie', 'storage_state', 'basic_auth']).optional(),
  login_url: z.string().url().nullable().optional(),
  auth_username_env: z.string().max(128).nullable().optional(),
  auth_password_env: z.string().max(128).nullable().optional(),
  auth_token_env: z.string().max(128).nullable().optional(),
  selector_strategy: z.enum(['role_first', 'testid_first', 'label_first', 'css_fallback']).optional(),
  selector_map: z.record(z.string()).optional(),
  known_testids: z.array(z.string()).optional(),
  page_inventory: z.array(z.any()).optional(),
  is_default: z.boolean().optional(),
});

router.patch('/:configId', validate(updateSchema), async (req, res, next) => {
  try {
    const updated = await targetAppConfigService.update(parseInt(req.params.configId, 10), req.user.id, req.body);
    if (!updated) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Config not found' } });
    res.json(updated);
  } catch (err) { next(err); }
});

router.delete('/:configId', async (req, res, next) => {
  try {
    const deleted = await targetAppConfigService.remove(parseInt(req.params.configId, 10), req.user.id);
    if (!deleted) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Config not found' } });
    res.json({ message: 'Deleted' });
  } catch (err) { next(err); }
});

module.exports = router;
