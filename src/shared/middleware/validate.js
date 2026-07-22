import { ValidationError } from '../errors/index.js';

const VALIDATABLE_SOURCES = ['body', 'query', 'params', 'headers'];

/**
 * Request validation from Zod schemas.
 *
 * Usage:
 *   router.post('/orders', validate({ body: createOrderSchema }), createOrder);
 *
 * Parsed (and therefore coerced and defaulted) values are exposed on
 * `req.validated`:
 *
 *   req.validated.body / .query / .params / .headers
 *
 * Handlers must read from `req.validated`, not from `req.body` / `req.query`.
 * Two reasons:
 *   1. `req.query` is a getter in Express 5 and cannot be reassigned, so the
 *      usual "overwrite req.query with the parsed value" trick throws.
 *   2. Reading the validated copy makes it obvious at the call site whether a
 *      value has been through a schema.
 *
 * All sources are validated before returning, so the client gets every field
 * error at once rather than discovering them one request at a time.
 *
 * @param {{ body?: import('zod').ZodType, query?: import('zod').ZodType,
 *           params?: import('zod').ZodType, headers?: import('zod').ZodType }} schemas
 */
export const validate = (schemas) => (req, _res, next) => {
  const validated = {};
  const issues = [];

  for (const source of VALIDATABLE_SOURCES) {
    const schema = schemas[source];
    if (!schema) continue;

    const result = schema.safeParse(req[source]);

    if (result.success) {
      validated[source] = result.data;
      continue;
    }

    for (const issue of result.error.issues) {
      issues.push({
        field: [source, ...issue.path].join('.'),
        message: issue.message,
        code: issue.code,
      });
    }
  }

  if (issues.length > 0) {
    return next(new ValidationError('Validation failed', { details: issues }));
  }

  req.validated = validated;
  return next();
};
