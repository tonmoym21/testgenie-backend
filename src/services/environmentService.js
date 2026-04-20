const db = require('../db');
const logger = require('../utils/logger');
const { NotFoundError } = require('../utils/apiError');

/**
 * Environment Variable Service
 * Supports three variable syntaxes:
 *   {{VAR_NAME}}          - direct env var lookup (legacy)
 *   {{env:VAR_NAME}}      - explicit env namespace (v2.3)
 *   {{response.prev.path}} - response chaining (resolved in collection runner)
 */

// Matches: {{VAR}}, {{env:VAR}}, {{response.prev.field.nested}}
const VAR_PATTERN = /\{\{(env:[A-Za-z_][A-Za-z0-9_]*|response\.prev\.[A-Za-z_][A-Za-z0-9_.]*|[A-Za-z_][A-Za-z0-9_]*)\}\}/g;

async function getEnvironments(userId) {
  const result = await db.query(
    `SELECT id, name, variables, is_secret AS "isSecret", is_active AS "isActive",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM environments WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows.map(maskSecrets);
}

async function getEnvironment(userId, envId) {
  const result = await db.query(
    `SELECT id, name, variables, is_secret AS "isSecret", is_active AS "isActive",
            created_at AS "createdAt"
     FROM environments WHERE id = $1 AND user_id = $2`,
    [envId, userId]
  );
  if (result.rows.length === 0) throw new NotFoundError('Environment');
  return maskSecrets(result.rows[0]);
}

async function getActiveEnvironment(userId) {
  const result = await db.query(
    `SELECT id, name, variables, is_secret AS "isSecret", is_active AS "isActive"
     FROM environments WHERE user_id = $1 AND is_active = true LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

async function createEnvironment(userId, data) {
  const { name, variables, isSecret = {}, isActive = false } = data;
  if (isActive) {
    await db.query('UPDATE environments SET is_active = false WHERE user_id = $1', [userId]);
  }
  const result = await db.query(
    `INSERT INTO environments (user_id, name, variables, is_secret, is_active)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, variables, is_secret AS "isSecret", is_active AS "isActive", created_at AS "createdAt"`,
    [userId, name, JSON.stringify(variables || {}), JSON.stringify(isSecret), isActive]
  );
  logger.info({ userId, envId: result.rows[0].id, name }, 'Environment created');
  return maskSecrets(result.rows[0]);
}

/**
 * Resolve a single string against a flat variables map.
 * Handles:
 *   {{VAR_NAME}}           → variables['VAR_NAME']
 *   {{env:VAR_NAME}}       → variables['VAR_NAME']  (strip "env:" prefix)
 *   {{response.prev.path}} → variables['response.prev.path']  (pre-injected by chain runner)
 */
function resolveVariables(text, variables) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(VAR_PATTERN, (match, token) => {
    // Normalise env: prefix → bare key
    const key = token.startsWith('env:') ? token.slice(4) : token;
    if (key in variables) return variables[key];
    // response.prev.* may be stored under full dotted key
    if (token in variables) return variables[token];
    logger.warn({ token }, 'Unresolved variable');
    return match;
  });
}

function resolveObjectVariables(obj, variables) {
  if (!obj || !variables) return obj;
  if (typeof obj === 'string') return resolveVariables(obj, variables);
  if (Array.isArray(obj)) return obj.map(item => resolveObjectVariables(item, variables));
  if (typeof obj === 'object') {
    const resolved = {};
    for (const [key, value] of Object.entries(obj)) {
      resolved[key] = resolveObjectVariables(value, variables);
    }
    return resolved;
  }
  return obj;
}

async function resolveTestDefinition(userId, testDef, envId = null) {
  let env;
  if (envId) {
    const result = await db.query(
      'SELECT variables FROM environments WHERE id = $1 AND user_id = $2',
      [envId, userId]
    );
    if (result.rows.length === 0) throw new NotFoundError('Environment');
    env = result.rows[0];
  } else {
    env = await getActiveEnvironment(userId);
  }
  if (!env || !env.variables) return testDef;
  const variables = typeof env.variables === 'string' ? JSON.parse(env.variables) : env.variables;
  return resolveObjectVariables(JSON.parse(JSON.stringify(testDef)), variables);
}

async function getRawVariables(userId, envId = null) {
  let result;
  if (envId) {
    result = await db.query('SELECT variables FROM environments WHERE id = $1 AND user_id = $2', [envId, userId]);
  } else {
    result = await db.query('SELECT variables FROM environments WHERE user_id = $1 AND is_active = true LIMIT 1', [userId]);
  }
  if (result.rows.length === 0) return {};
  const vars = result.rows[0].variables;
  return typeof vars === 'string' ? JSON.parse(vars) : vars || {};
}

/**
 * Get global variables for a user and merge them into a flat map.
 * Global vars are injected BEFORE env vars so env vars can override them.
 */
async function getGlobalVariables(userId) {
  const result = await db.query(
    'SELECT key, value FROM global_variables WHERE user_id = $1',
    [userId]
  );
  const map = {};
  for (const row of result.rows) map[row.key] = row.value;
  return map;
}

/**
 * Build merged variable context: globals → env vars → chain overrides
 * Priority (highest wins): chainVars > envVars > globalVars
 */
async function buildVariableContext(userId, envId = null, chainVars = {}) {
  const globalVars = await getGlobalVariables(userId);
  const envVars = await getRawVariables(userId, envId);
  return { ...globalVars, ...envVars, ...chainVars };
}

/**
 * Inject previous response data into chain vars as "response.prev.*" keys.
 * Handles nested objects via dot-flattening one level deep.
 */
function buildChainVars(prevResponseBody) {
  if (!prevResponseBody || typeof prevResponseBody !== 'object') return {};
  const chain = {};
  function flatten(obj, prefix) {
    for (const [k, v] of Object.entries(obj)) {
      const dotKey = `${prefix}.${k}`;
      chain[dotKey] = String(v ?? '');
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        flatten(v, dotKey);
      }
    }
  }
  flatten(prevResponseBody, 'response.prev');
  return chain;
}

function maskSecrets(env) {
  if (!env) return env;
  const isSecret = typeof env.isSecret === 'string' ? JSON.parse(env.isSecret) : env.isSecret || {};
  const variables = typeof env.variables === 'string' ? JSON.parse(env.variables) : env.variables || {};
  const maskedVariables = { ...variables };
  for (const [key, isSecretVar] of Object.entries(isSecret)) {
    if (isSecretVar && key in maskedVariables) maskedVariables[key] = '••••••••';
  }
  return { ...env, variables: maskedVariables, isSecret };
}

function maskSecretsInText(text, secretValues) {
  if (!text || !secretValues || secretValues.length === 0) return text;
  let masked = text;
  for (const secret of secretValues) {
    if (secret && secret.length > 3) masked = masked.replaceAll(secret, '••••••••');
  }
  return masked;
}

async function getSecretValues(userId, envId = null) {
  let result;
  if (envId) {
    result = await db.query('SELECT variables, is_secret FROM environments WHERE id = $1 AND user_id = $2', [envId, userId]);
  } else {
    result = await db.query('SELECT variables, is_secret FROM environments WHERE user_id = $1 AND is_active = true LIMIT 1', [userId]);
  }
  if (result.rows.length === 0) return [];
  const env = result.rows[0];
  const variables = typeof env.variables === 'string' ? JSON.parse(env.variables) : env.variables || {};
  const isSecret = typeof env.is_secret === 'string' ? JSON.parse(env.is_secret) : env.is_secret || {};
  const secrets = [];
  for (const [key, isSecretVar] of Object.entries(isSecret)) {
    if (isSecretVar && variables[key]) secrets.push(variables[key]);
  }
  return secrets;
}

module.exports = {
  getEnvironments, getEnvironment, getActiveEnvironment, createEnvironment,
  resolveVariables, resolveObjectVariables, resolveTestDefinition,
  getRawVariables, getGlobalVariables, buildVariableContext, buildChainVars,
  maskSecrets, maskSecretsInText, getSecretValues,
};
