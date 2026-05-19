/**
 * Chain session store for individual single-test runs within a collection.
 *
 * Why this exists: the collection orchestrator (Run All / run-stream) builds
 * a cookie jar + chain vars and walks the tests in order, so chaining "just
 * works." When a user runs a single test via the ▶ on its row, the existing
 * endpoint runs it in isolation — no jar, no previous extractor values.
 * Iterating on a chained collection one step at a time then 401s on every
 * step after Login because cookies never persist.
 *
 * Each (userId, collectionId) gets one session containing the per-run
 * tough-cookie jar and an accumulating `chainVars` map. Subsequent
 * single-test runs read + update both. Sessions auto-expire after TTL_MS
 * idle to keep memory bounded; a sweep runs on each access (cheap, no
 * timer).
 *
 * Persistence layout:
 *   - In-memory Map is the hot path — every read tries the cache first.
 *   - On cache miss we fall back to the `chain_sessions` table; if a row
 *     newer than TTL exists, we hydrate from it.
 *   - After mutation, the caller invokes `persist(userId, collectionId)`
 *     which writes the serialised jar + chainVars back. Failed DB writes
 *     log a warning but don't break the in-memory session — the user keeps
 *     working; only restart-survival is lost for that session.
 *
 * Write-through (not write-back) so that a backend restart never loses
 * more than the in-flight request currently mutating the session.
 */
const { CookieJar } = require('tough-cookie');
const cookieJarLib = require('./cookieJar');
const db = require('../db');
const logger = require('../utils/logger');

const TTL_MS = 60 * 60 * 1000;   // 1 hour idle
const sessions = new Map();      // key → { jar, chainVars, createdAt, updatedAt }

function key(userId, collectionId) {
  return `${userId}:${collectionId}`;
}

function sweepInMemory(nowMs) {
  for (const [k, v] of sessions) {
    if (nowMs - v.updatedAt > TTL_MS) sessions.delete(k);
  }
}

/**
 * Deserialise a tough-cookie jar from its stored JSON form. CookieJar
 * exposes `deserialize` (callback-style in old releases, Promise in 4.x+).
 * We probe for the Promise variant and fall back to a callback wrapper so
 * this works across tough-cookie versions without locking a specific one.
 */
function jarFromJson(serialised) {
  if (!serialised) return cookieJarLib.createJar();
  return new Promise((resolve) => {
    try {
      const r = CookieJar.deserialize(serialised);
      if (r && typeof r.then === 'function') {
        r.then((jar) => resolve(jar || cookieJarLib.createJar()))
         .catch((err) => {
           logger.warn({ err: err.message }, 'Chain session jar deserialise failed; using empty jar');
           resolve(cookieJarLib.createJar());
         });
      } else if (r) {
        resolve(r);
      } else {
        // Old callback signature
        CookieJar.deserialize(serialised, (err, jar) => {
          if (err) {
            logger.warn({ err: err.message }, 'Chain session jar deserialise failed; using empty jar');
            resolve(cookieJarLib.createJar());
          } else resolve(jar || cookieJarLib.createJar());
        });
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'Chain session jar deserialise threw; using empty jar');
      resolve(cookieJarLib.createJar());
    }
  });
}

async function jarToJsonSafe(jar) {
  if (!jar) return null;
  try {
    const r = jar.toJSON ? jar.toJSON() : (jar.serializeSync ? jar.serializeSync() : null);
    return r;
  } catch (err) {
    logger.warn({ err: err.message }, 'Chain session jar serialise failed');
    return null;
  }
}

async function loadFromDb(userId, collectionId) {
  try {
    const r = await db.query(
      `SELECT jar_json, chain_vars,
              EXTRACT(EPOCH FROM created_at) * 1000 AS created_ms,
              EXTRACT(EPOCH FROM updated_at) * 1000 AS updated_ms
         FROM chain_sessions
        WHERE user_id = $1 AND collection_id = $2
          AND updated_at > NOW() - INTERVAL '1 hour'`,
      [userId, collectionId]
    );
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    const jar = await jarFromJson(row.jar_json);
    return {
      jar,
      chainVars: row.chain_vars || {},
      createdAt: Number(row.created_ms),
      updatedAt: Number(row.updated_ms),
    };
  } catch (err) {
    logger.warn({ err: err.message, userId, collectionId }, 'Failed to load chain session from DB');
    return null;
  }
}

async function saveToDb(userId, collectionId, session) {
  try {
    const jarJson = await jarToJsonSafe(session.jar);
    if (!jarJson) return;
    await db.query(
      `INSERT INTO chain_sessions (user_id, collection_id, jar_json, chain_vars, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, to_timestamp($5/1000.0), to_timestamp($6/1000.0))
       ON CONFLICT (user_id, collection_id) DO UPDATE SET
         jar_json = EXCLUDED.jar_json,
         chain_vars = EXCLUDED.chain_vars,
         updated_at = EXCLUDED.updated_at`,
      [userId, collectionId, JSON.stringify(jarJson), JSON.stringify(session.chainVars || {}),
       session.createdAt, session.updatedAt]
    );
  } catch (err) {
    logger.warn({ err: err.message, userId, collectionId }, 'Failed to persist chain session (continuing in-memory)');
  }
}

/**
 * Get the session for this (user, collection), creating it on first touch
 * and hydrating from DB if the in-memory cache is cold but a recent row
 * exists. Always returns a live object the caller can mutate; callers
 * should `await persist(...)` after mutating so the row survives restart.
 */
async function getOrCreate(userId, collectionId) {
  const now = Date.now();
  sweepInMemory(now);
  const k = key(userId, collectionId);
  let s = sessions.get(k);
  if (s) {
    s.updatedAt = now;
    return s;
  }
  // Cache miss — try DB hydration.
  const fromDb = await loadFromDb(userId, collectionId);
  if (fromDb) {
    fromDb.updatedAt = now;
    sessions.set(k, fromDb);
    return fromDb;
  }
  // No persistent session — start fresh.
  s = {
    jar: cookieJarLib.createJar(),
    chainVars: {},
    createdAt: now,
    updatedAt: now,
  };
  sessions.set(k, s);
  return s;
}

/**
 * Persist the in-memory session for this (user, collection) to the DB.
 * Safe to call when no session exists (no-op). Errors swallowed and logged.
 */
async function persist(userId, collectionId) {
  const s = sessions.get(key(userId, collectionId));
  if (!s) return;
  await saveToDb(userId, collectionId, s);
}

/**
 * Peek without creating. Used by the status endpoint so a GET doesn't
 * silently spin up an empty session. Hydrates from DB if memory is cold.
 */
async function peek(userId, collectionId) {
  const now = Date.now();
  sweepInMemory(now);
  const k = key(userId, collectionId);
  let s = sessions.get(k);
  if (s) return s;
  const fromDb = await loadFromDb(userId, collectionId);
  if (fromDb) {
    sessions.set(k, fromDb);
    return fromDb;
  }
  return null;
}

async function reset(userId, collectionId) {
  sessions.delete(key(userId, collectionId));
  try {
    await db.query(
      'DELETE FROM chain_sessions WHERE user_id = $1 AND collection_id = $2',
      [userId, collectionId]
    );
  } catch (err) {
    logger.warn({ err: err.message, userId, collectionId }, 'Failed to clear persisted chain session row');
  }
  return true;
}

/**
 * Lightweight snapshot for the UI's session badge.
 */
async function status(userId, collectionId) {
  const s = await peek(userId, collectionId);
  if (!s) return { active: false };
  const cookies = await cookieJarLib.snapshot(s.jar);
  return {
    active: true,
    cookieCount: cookies.length,
    chainVarCount: Object.keys(s.chainVars).length,
    createdAt: new Date(s.createdAt).toISOString(),
    updatedAt: new Date(s.updatedAt).toISOString(),
    ttlSeconds: Math.max(0, Math.floor((TTL_MS - (Date.now() - s.updatedAt)) / 1000)),
  };
}

module.exports = { getOrCreate, peek, reset, status, persist, TTL_MS };
