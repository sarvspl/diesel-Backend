import { randomUUID } from 'node:crypto';

const REQUEST_ID_HEADER = 'x-request-id';

/**
 * An inbound id is only trusted if it is short and alphanumeric. Without this
 * check a caller could inject newlines into every log line for this request
 * (log forging) or push megabytes through the logging pipeline.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Assigns a correlation id to every request.
 *
 * Reuses an upstream `X-Request-Id` when the load balancer or calling service
 * already set one, so a single id follows a request across process boundaries.
 * Always echoed back on the response so support can correlate a user report
 * with the exact log lines.
 *
 * Must be mounted before the HTTP logger.
 */
export const requestId = (req, res, next) => {
  const incoming = req.get(REQUEST_ID_HEADER);
  const id = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();

  req.id = id;
  res.setHeader('X-Request-Id', id);

  next();
};
