const db = require('../db');
const logger = require('../utils/logger');
const { NotFoundError } = require('../utils/apiError');

/**
 * Environment Variable Service
 * Handles CRUD, resolution, and secure secret masking
 */

// Regex to match {{VARIABLE_NAME}} patterns
const VAR_PATTERN = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

/**
 * Get all environments for a user
 */
async function getEnvironments(userId) {
  const result = await db.query(
    `SELECT id, name, variables, is_secret AS "isSecret", is_active AS "isActive", 
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM environments WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows.map(maskSecrets);
}

/**
 * Get single environment by ID
 */
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

/**
 * Get active environment for a user
 */
async function getActiveEnvironment(userId) {
  const result = await db.query(
    `SELECT id, name, variables, is_secret AS "isSecret", is_active AS "isActive"
     FROM environments WHERE user_id = $1 AND is_active = true LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

/**
 * Create a new environment
 */
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
 * Resolve variables in a string using environment variables
 */
function resolveVariables(text, variables) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(VAR_PATTERN, (match, varName) => {
    if (varName in variables) return variables[varName];
    logger.warn({ varName }, 'Unresolved environment variable');
    return match;
  });
}

/**
 * Resolve variables in an object recursively
 */
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

/**
 * Resolve test definition with environment variables
 */
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

/**
 * Get raw variables for resolution (includes secrets)
 */
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
 * Mask secret values in environment response
 */
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

/**
 * Mask secrets in logs and error messages
 */
function maskSecretsInText(text, secretValues) {
  if (!text || !secretValues || secretValues.length === 0) return text;
  let masked = text;
  for (const secret of secretValues) {
    if (secret && secret.length > 3) masked = masked.replaceAll(secret, '••••••••');
  }
  return masked;
}

/**
 * Get list of secret values for masking in logs
 */
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
  getRawVariables, maskSecrets, maskSecretsInText, getSecretValues,
};
