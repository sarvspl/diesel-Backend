import { ERROR_CODES } from '../constants/error-codes.js';
import { HTTP_STATUS } from '../constants/http-status.js';

/**
 * Base class for every error the application raises deliberately.
 *
 * The distinction that matters is `isOperational`:
 *
 *   operational  - an expected outcome of a valid request path (not found,
 *                  forbidden, conflict, validation). Safe to describe to the
 *                  caller, logged at `warn`.
 *   programmer   - a bug or an unexpected failure. The message is replaced by
 *                  a generic one before it reaches the client, and it is
 *                  logged at `error` with the full stack.
 *
 * Anything thrown that is NOT an AppError is treated as a programmer error.
 */
export class AppError extends Error {
  /**
   * @param {string} message           Human-readable, safe to expose when operational.
   * @param {object} [options]
   * @param {number} [options.statusCode]    HTTP status to respond with.
   * @param {string} [options.code]          Stable machine-readable code.
   * @param {unknown} [options.details]      Structured detail for the client (never sensitive).
   * @param {boolean} [options.isOperational]
   * @param {unknown} [options.cause]        Underlying error, logged but never exposed.
   */
  constructor(message, options = {}) {
    const {
      statusCode = HTTP_STATUS.INTERNAL_SERVER_ERROR,
      code = ERROR_CODES.INTERNAL_SERVER_ERROR,
      details,
      isOperational = true,
      cause,
    } = options;

    super(message, cause === undefined ? undefined : { cause });

    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = isOperational;

    Error.captureStackTrace?.(this, new.target);
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', options = {}) {
    super(message, {
      statusCode: HTTP_STATUS.BAD_REQUEST,
      code: ERROR_CODES.BAD_REQUEST,
      ...options,
    });
  }
}

/**
 * Request failed schema validation.
 * `details` carries the per-field issues produced by `validate()`.
 */
export class ValidationError extends AppError {
  constructor(message = 'Validation failed', options = {}) {
    super(message, {
      statusCode: HTTP_STATUS.BAD_REQUEST,
      code: ERROR_CODES.VALIDATION_ERROR,
      details: [],
      ...options,
    });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', options = {}) {
    super(message, {
      statusCode: HTTP_STATUS.UNAUTHORIZED,
      code: ERROR_CODES.UNAUTHORIZED,
      ...options,
    });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action', options = {}) {
    super(message, {
      statusCode: HTTP_STATUS.FORBIDDEN,
      code: ERROR_CODES.FORBIDDEN,
      ...options,
    });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', options = {}) {
    super(message, {
      statusCode: HTTP_STATUS.NOT_FOUND,
      code: ERROR_CODES.NOT_FOUND,
      ...options,
    });
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Request conflicts with the current state of the resource', options = {}) {
    super(message, {
      statusCode: HTTP_STATUS.CONFLICT,
      code: ERROR_CODES.CONFLICT,
      ...options,
    });
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = 'Too many requests, please try again later', options = {}) {
    super(message, {
      statusCode: HTTP_STATUS.TOO_MANY_REQUESTS,
      code: ERROR_CODES.RATE_LIMIT_EXCEEDED,
      ...options,
    });
  }
}

/** A dependency the request needed (database, external provider) is unavailable. */
export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable', options = {}) {
    super(message, {
      statusCode: HTTP_STATUS.SERVICE_UNAVAILABLE,
      code: ERROR_CODES.SERVICE_UNAVAILABLE,
      ...options,
    });
  }
}

/** Explicit "this is our fault" error. Message is never exposed in production. */
export class InternalServerError extends AppError {
  constructor(message = 'Internal server error', options = {}) {
    super(message, {
      statusCode: HTTP_STATUS.INTERNAL_SERVER_ERROR,
      code: ERROR_CODES.INTERNAL_SERVER_ERROR,
      isOperational: false,
      ...options,
    });
  }
}
