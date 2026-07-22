import { HTTP_STATUS } from '../constants/http-status.js';

/**
 * The single place where a successful response envelope is constructed.
 *
 * Every 2xx body on this API has the shape:
 *   { success: true, message: string, data: unknown }
 *
 * Controllers call these helpers rather than `res.json` directly, so the
 * contract cannot drift module by module.
 */

/**
 * @param {import('express').Response} res
 * @param {object} [options]
 * @param {number} [options.statusCode]
 * @param {string} [options.message]
 * @param {unknown} [options.data]
 * @param {Record<string, unknown>} [options.meta] Pagination or similar envelope metadata.
 */
export const sendSuccess = (res, options = {}) => {
  const {
    statusCode = HTTP_STATUS.OK,
    message = 'Operation successful',
    data = {},
    meta,
  } = options;

  const body = { success: true, message, data };
  if (meta !== undefined) body.meta = meta;

  return res.status(statusCode).json(body);
};

/** 201 with the created resource. */
export const sendCreated = (res, { message = 'Resource created successfully', data } = {}) =>
  sendSuccess(res, { statusCode: HTTP_STATUS.CREATED, message, data });
