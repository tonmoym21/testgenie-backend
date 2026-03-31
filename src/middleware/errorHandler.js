const { ApiError } = require('../utils/apiError');
const logger = require('../utils/logger');
const config = require('../config');

/**
 * Centralized error handler. Must be registered last in the middleware stack.
 */
function errorHandler(err, _req, res, _next) {
  // Known API errors
  if (err instanceof ApiError) {
    logger.warn({ code: err.code, message: err.message }, 'API error');
    return res.status(err.statusCode).json(err.toJSON());
  }

  // Zod validation errors (from validate middleware)
  if (err.name === 'ZodError') {
    const details = err.errors.map((e) => ({
      field: e.path.join('.'),
      message: e.message,
    }));
    logger.warn({ details }, 'Validation error');
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details,
      },
    });
  }

  // JSON parse errors
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid JSON in request body',
      },
    });
  }

  // Unexpected errors
  logger.error({ err }, 'Unhandled error');

  const message =
    config.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message;

  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message,
    },
  });
}

module.exports = { errorHandler };
