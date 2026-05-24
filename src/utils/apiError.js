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

// 503 — the route is wired and the request is valid, but a backing
// capability the operator hasn't enabled (e.g. OPENAI_API_KEY unset
// in an Ollama-only deployment) is needed. Distinct from AiProviderError
// (the key is present but the upstream LLM failed) and from a 500
// (genuine server bug).
class FeatureUnavailableError extends ApiError {
  constructor(feature, hint = null) {
    const msg = hint
      ? `${feature} is not available in this deployment: ${hint}`
      : `${feature} is not available in this deployment`;
    super(503, 'FEATURE_UNAVAILABLE', msg);
    this.feature = feature;
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
  FeatureUnavailableError,
};
