/**
 * Creates a middleware that validates req.body against a Zod schema.
 *
 * @param {import('zod').ZodSchema} schema
 * @returns {Function} Express middleware
 */
function validate(schema) {
  return (req, _res, next) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      next(err); // Caught by errorHandler as ZodError
    }
  };
}

/**
 * Validates req.query against a Zod schema.
 */
function validateQuery(schema) {
  return (req, _res, next) => {
    try {
      req.query = schema.parse(req.query);
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { validate, validateQuery };
