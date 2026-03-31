const logger = require('./logger');

/**
 * Retry a function with exponential backoff.
 *
 * @param {Function} fn - Async function to retry
 * @param {Object} options
 * @param {number} options.maxAttempts - Max number of attempts (default 3)
 * @param {number} options.initialDelayMs - Initial delay in ms (default 1000)
 * @param {number} options.maxDelayMs - Max delay cap in ms (default 10000)
 * @param {Function} options.shouldRetry - Predicate receiving the error, returns boolean
 * @returns {Promise<*>}
 */
async function retry(fn, options = {}) {
  const {
    maxAttempts = 3,
    initialDelayMs = 1000,
    maxDelayMs = 10000,
    shouldRetry = () => true,
  } = options;

  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt === maxAttempts || !shouldRetry(err)) {
        throw err;
      }

      const delay = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const jitter = delay * (0.5 + Math.random() * 0.5);

      logger.warn(
        { attempt, maxAttempts, delayMs: Math.round(jitter), error: err.message },
        'Retrying after error'
      );

      await new Promise((resolve) => setTimeout(resolve, jitter));
    }
  }

  throw lastError;
}

module.exports = { retry };
