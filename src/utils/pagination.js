// Defaults and ceilings for list-endpoint pagination. Clamping here protects
// against unbounded `limit=999999` requests that exhaust DB memory.

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_LIMIT_AUDIT = 1000; // export endpoints (audit, run reports) need higher ceiling

function toInt(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Parse and clamp { page, limit } from a query object.
 * @param {object} query - typically req.query
 * @param {object} [opts]
 * @param {number} [opts.defaultLimit=50]
 * @param {number} [opts.maxLimit=100]
 * @returns {{ page: number, limit: number, offset: number }}
 */
function parseListPagination(query = {}, opts = {}) {
  const defaultLimit = opts.defaultLimit ?? DEFAULT_LIMIT;
  const maxLimit = opts.maxLimit ?? MAX_LIMIT;
  const page = Math.max(1, toInt(query.page, 1));
  const rawLimit = toInt(query.limit, defaultLimit);
  const limit = Math.min(Math.max(1, rawLimit), maxLimit);
  return { page, limit, offset: (page - 1) * limit };
}

module.exports = {
  parseListPagination,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_LIMIT_AUDIT,
};
