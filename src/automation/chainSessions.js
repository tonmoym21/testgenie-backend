/**
 * In-memory chain session store for individual single-test runs within a
 * collection.
 *
 * Why this exists: the collection orchestrator (Run All / run-stream) builds
 * a cookie jar + chain vars and walks the tests in order, so chaining "just
 * works." When a user runs a single test via the ▶️ on its row, the existing
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
 * This is process-local on purpose — it would defeat the iterative-debug
 * use case to round-trip a serialised jar through Postgres on every click,
 * and the persistence semantics we'd want (clear on logout? on collection
 * edit?) aren't worth the table for a debugger affordance.
 */
const cookieJarLib = require('./cookieJar');

const TTL_MS = 60 * 60 * 1000;   // 1 hour idle
const sessions = new Map();      // key → { jar, chainVars, createdAt, updatedAt }

function key(userId, collectionId) {
  return `${userId}:${collectionId}`;
}

function sweepExpired(nowMs) {
  for (const [k, v] of sessions) {
    if (nowMs - v.updatedAt > TTL_MS) sessions.delete(k);
  }
}

/**
 * Get the session for this (user, collection), creating it on first touch.
 * Always returns a live object the caller can mutate.
 */
function getOrCreate(userId, collectionId) {
  const now = Date.now();
  sweepExpired(now);
  const k = key(userId, collectionId);
  let s = sessions.get(k);
  if (!s) {
    s = {
      jar: cookieJarLib.createJar(),
      chainVars: {},
      createdAt: now,
      updatedAt: now,
    };
    sessions.set(k, s);
  }
  s.updatedAt = now;
  return s;
}

/**
 * Peek without creating. Used by the status endpoint so a GET doesn't
 * silently spin up an empty session.
 */
function peek(userId, collectionId) {
  sweepExpired(Date.now());
  return sessions.get(key(userId, collectionId)) || null;
}

function reset(userId, collectionId) {
  return sessions.delete(key(userId, collectionId));
}

/**
 * Lightweight snapshot for the UI's session badge.
 */
async function status(userId, collectionId) {
  const s = peek(userId, collectionId);
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

module.exports = { getOrCreate, peek, reset, status, TTL_MS };
