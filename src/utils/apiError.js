class ApiError extends Error {
  constructor(statusCode, code, message, details = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    const body = {
      error: {
        code: this.code,
        message: this.message,
      },
    };
    if (this.details) {
      body.error.details = this.details;
    }
    return body;
  }
}

class ValidationError extends ApiError {
  constructor(details) {
    super(400, 'VALIDATION_ERROR', 'Validation failed', details);
  }
}

class UnauthorizedError extends ApiError {
  constructor(message = 'Unauthorized') {
    super(401, 'UNAUTHORIZED', message);
  }
}

class ForbiddenError extends ApiError {
  constructor(message = 'Forbidden') {
    super(403, 'FORBIDDEN', message);
  }
}

class NotFoundError extends ApiError {
  constructor(resource = 'Resource') {
    super(404, 'NOT_FOUND', `${resource} not found`);
  }
}

class ConflictError extends ApiError {
  constructor(message = 'Resource already exists') {
    super(409, 'CONFLICT', message);
  }
}

class RateLimitError extends ApiError {
  constructor() {
    super(429, 'RATE_LIMITED', 'Too many requests, please try again later');
  }
}

class AiProviderError extends ApiError {
  constructor(message = 'AI provider error') {
    super(502, 'AI_PROVIDER_ERROR', message);
  }
}

module.exports = {
  ApiError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  AiProviderError,
};
