import { sendCreated, sendSuccess } from '../../shared/utils/api-response.js';

import * as catalogService from './services/catalog.service.js';
import * as fyftService from './services/fyft.service.js';
import * as priceService from './services/price.service.js';
import * as quoteService from './services/quote.service.js';

/**
 * Thin HTTP layer for pricing & catalogue.
 *
 * The acting user always comes from `req.auth`. That matters more here than
 * anywhere else so far: `createdByUserId` on a price is what the
 * separation-of-duties check compares against when an out-of-band change is
 * approved (BR-607), so a body-supplied actor would let one person author a
 * price under someone else's name and then approve their own work.
 */

// --- Products --------------------------------------------------------------

/** GET /api/v1/admin/products */
export const listProducts = async (req, res) => {
  const result = await catalogService.listProducts(req.validated.query);

  return sendSuccess(res, { message: 'Products retrieved', data: result });
};

/** POST /api/v1/admin/products */
export const createProduct = async (req, res) => {
  const product = await catalogService.createProduct({
    actorUserId: req.auth.userId,
    ...req.validated.body,
  });

  return sendCreated(res, { message: 'Product created', data: { product } });
};

/** PATCH /api/v1/admin/products/:id */
export const updateProduct = async (req, res) => {
  const product = await catalogService.updateProduct({
    id: req.validated.params.id,
    actorUserId: req.auth.userId,
    ...req.validated.body,
  });

  return sendSuccess(res, { message: 'Product updated', data: { product } });
};

// --- Prices ----------------------------------------------------------------

/** GET /api/v1/admin/prices */
export const listPrices = async (req, res) => {
  const result = await priceService.listPrices(req.validated.query);

  return sendSuccess(res, { message: 'Prices retrieved', data: result });
};

/**
 * POST /api/v1/admin/prices
 *
 * 201 either way. An out-of-band price IS created - it is parked pending a
 * second administrator rather than rejected - and the `warning` in the body
 * tells the client it is not yet live (BR-607).
 */
/** POST /api/v1/admin/fyft-rate — push our HSD rate to the FYFT device platform. */
export const pushFyftRate = async (req, res) => {
  const result = await fyftService.pushHsdRate({ rate: req.validated.body.rate });

  return sendSuccess(res, { message: 'Rate sent to FYFT', data: result });
};

export const publishPrice = async (req, res) => {
  const result = await priceService.publishPrice({
    actorUserId: req.auth.userId,
    ...req.validated.body,
  });

  return sendCreated(res, {
    message: result.warning ? 'Price created and held for approval' : 'Price published',
    data: result,
  });
};

/** PATCH /api/v1/admin/prices/:id/status */
export const updatePriceStatus = async (req, res) => {
  const price = await priceService.updatePriceStatus({
    id: req.validated.params.id,
    actorUserId: req.auth.userId,
    // Passed explicitly so the service can enforce the approval grant without
    // reaching into the request - it stays a testable pure-ish function.
    actorPermissions: req.auth.permissions,
    ...req.validated.body,
  });

  return sendSuccess(res, { message: 'Price status updated', data: { price } });
};

// --- Tax rules -------------------------------------------------------------

/** GET /api/v1/admin/taxes */
export const listTaxRules = async (req, res) => {
  const result = await catalogService.listTaxRules(req.validated.query);

  return sendSuccess(res, { message: 'Tax rules retrieved', data: result });
};

/** POST /api/v1/admin/taxes */
export const createTaxRule = async (req, res) => {
  const taxRule = await catalogService.createTaxRule({
    actorUserId: req.auth.userId,
    ...req.validated.body,
  });

  return sendCreated(res, { message: 'Tax rule created', data: { taxRule } });
};

/** PATCH /api/v1/admin/taxes/:id */
export const updateTaxRule = async (req, res) => {
  const taxRule = await catalogService.updateTaxRule({
    id: req.validated.params.id,
    actorUserId: req.auth.userId,
    ...req.validated.body,
  });

  return sendSuccess(res, { message: 'Tax rule updated', data: { taxRule } });
};

// --- Delivery charges ------------------------------------------------------

/** GET /api/v1/admin/delivery-charges */
export const listDeliveryRules = async (req, res) => {
  const result = await catalogService.listDeliveryRules(req.validated.query);

  return sendSuccess(res, { message: 'Delivery charge rules retrieved', data: result });
};

/** POST /api/v1/admin/delivery-charges */
export const createDeliveryRule = async (req, res) => {
  const deliveryChargeRule = await catalogService.createDeliveryRule({
    actorUserId: req.auth.userId,
    ...req.validated.body,
  });

  return sendCreated(res, {
    message: 'Delivery charge rule created',
    data: { deliveryChargeRule },
  });
};

// --- Quotes ----------------------------------------------------------------

/** POST /api/v1/quotes */
export const createQuote = async (req, res) => {
  const quote = await quoteService.createQuote({
    userId: req.auth.userId,
    ...req.validated.body,
  });

  return sendCreated(res, { message: 'Quote generated', data: { quote } });
};

/** GET /api/v1/quotes/:id */
export const getQuote = async (req, res) => {
  const quote = await quoteService.getQuote({
    id: req.validated.params.id,
    userId: req.auth.userId,
  });

  return sendSuccess(res, { message: 'Quote retrieved', data: { quote } });
};
