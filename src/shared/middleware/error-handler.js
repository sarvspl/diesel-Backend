import { isProduction } from '../../config/env.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { HTTP_STATUS } from '../constants/http-status.js';
import { AppError } from '../errors/index.js';
import { logger } from '../logger/index.js';

/** Prisma surfaces failures as `PrismaClientKnownRequestError` etc. with a `Pxxxx` code. */
const isPrismaError = (err) =>
  typeof err?.name === 'string' &&
  err.name.startsWith('PrismaClient') &&
  (typeof err.code !== 'string' || /^P\d{4}$/.test(err.code));

const isZodError = (err) => err?.name === 'ZodError' && Array.isArray(err?.issues);

/**
 * Map a Prisma failure onto an HTTP result.
 *
 * Prisma messages name tables and columns, so they are treated as internal
 * detail and only surfaced outside production.
 */
const fromPrismaError = (err) => {
  switch (err.code) {
    case 'P2002':
      return {
        statusCode: HTTP_STATUS.CONFLICT,
        code: ERROR_CODES.CONFLICT,
        message: 'A record with these values already exists',
        isOperational: true,
      };
    case 'P2025':
      return {
        statusCode: HTTP_STATUS.NOT_FOUND,
        code: ERROR_CODES.NOT_FOUND,
        message: 'Resource not found',
        isOperational: true,
      };
    case 'P2003':
      return {
        statusCode: HTTP_STATUS.CONFLICT,
        code: ERROR_CODES.CONFLICT,
        message: 'Related record does not exist or is still referenced',
        isOperational: true,
      };
    // Connection-level failures: the database is unreachable, not the caller's fault.
    case 'P1000':
    case 'P1001':
    case 'P1002':
    case 'P1017':
      return {
        statusCode: HTTP_STATUS.SERVICE_UNAVAILABLE,
        code: ERROR_CODES.SERVICE_UNAVAILABLE,
        message: 'Service temporarily unavailable',
        isOperational: true,
      };
    default:
      return {
        statusCode: HTTP_STATUS.INTERNAL_SERVER_ERROR,
        code: ERROR_CODES.DATABASE_ERROR,
        message: 'A database error occurred',
        isOperational: false,
      };
  }
};

/** Body-parser rejections arrive as plain errors tagged with a `type`. */
const fromBodyParserError = (err) => {
  switch (err.type) {
    case 'entity.too.large':
      return {
        statusCode: HTTP_STATUS.PAYLOAD_TOO_LARGE,
        code: ERROR_CODES.PAYLOAD_TOO_LARGE,
        message: 'Request body is too large',
        isOperational: true,
      };
    case 'entity.parse.failed':
      return {
        statusCode: HTTP_STATUS.BAD_REQUEST,
        code: ERROR_CODES.MALFORMED_JSON,
        message: 'Request body is not valid JSON',
        isOperational: true,
      };
    case 'encoding.unsupported':
      return {
        statusCode: HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE,
        code: ERROR_CODES.UNSUPPORTED_MEDIA_TYPE,
        message: 'Unsupported content encoding',
        isOperational: true,
      };
    default:
      return null;
  }
};

/** Reduce any thrown value to a consistent internal shape. */
const normalise = (err) => {
  if (err instanceof AppError) {
    return {
      statusCode: err.statusCode,
      code: err.code,
      message: err.message,
      details: err.details,
      isOperational: err.isOperational,
    };
  }

  if (isZodError(err)) {
    return {
      statusCode: HTTP_STATUS.BAD_REQUEST,
      code: ERROR_CODES.VALIDATION_ERROR,
      message: 'Validation failed',
      details: err.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
        code: issue.code,
      })),
      isOperational: true,
    };
  }

  if (typeof err?.type === 'string') {
    const mapped = fromBodyParserError(err);
    if (mapped) return mapped;
  }

  if (isPrismaError(err)) {
    return fromPrismaError(err);
  }

  return {
    statusCode: HTTP_STATUS.INTERNAL_SERVER_ERROR,
    code: ERROR_CODES.INTERNAL_SERVER_ERROR,
    message: 'Internal server error',
    isOperational: false,
  };
};

/**
 * Centralised error handler. Must be the last middleware registered.
 *
 * Guarantees:
 *   - every error response uses the same envelope;
 *   - stack traces and internal messages never reach a production client;
 *   - every error is logged once, with the request id attached.
 *
 * `next` is required for Express to recognise this as an error handler, even
 * though it is only used for the headers-already-sent case.
 */
export const errorHandler = (err, req, res, next) => {
  // The response has already begun streaming; nothing can be changed now.
  // Express's default handler will destroy the socket.
  if (res.headersSent) {
    return next(err);
  }

  const { statusCode, code, message, details, isOperational } = normalise(err);

  const log = req.log ?? logger;
  const logContext = { err, statusCode, code, requestId: req.id };

  if (statusCode >= HTTP_STATUS.INTERNAL_SERVER_ERROR) {
    log.error(logContext, message);
  } else {
    log.warn(logContext, message);
  }

  // Unexpected failures are described generically in production. Operational
  // errors are safe to describe because we authored their messages.
  const exposeDetail = isOperational || !isProduction;

  const body = {
    success: false,
    message: exposeDetail ? message : 'Internal server error',
    error: {
      code,
    },
    requestId: req.id,
  };

  if (exposeDetail && details !== undefined) {
    body.error.details = details;
  }

  if (!isProduction && err instanceof Error && err.stack) {
    body.error.stack = err.stack.split('\n');
  }

  return res.status(statusCode).json(body);
};
