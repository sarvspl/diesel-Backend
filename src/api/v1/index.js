import { Router } from 'express';

import corporateAdminRoutes from '../../modules/corporate/corporate.admin.routes.js';
import corporateRoutes from '../../modules/corporate/corporate.routes.js';
import { installCorporateLoginGate } from '../../modules/corporate/services/corporate-gate.js';
import customerAdminRoutes from '../../modules/customer/customer.admin.routes.js';
import customerRoutes from '../../modules/customer/customer.routes.js';
import driverRoutes from '../../modules/driver/driver.routes.js';
import fleetAdminRoutes from '../../modules/fleet/fleet.admin.routes.js';
import healthRoutes from '../../modules/health/health.routes.js';
import identityRoutes from '../../modules/identity/identity.routes.js';
import orderAdminRoutes from '../../modules/order/order.admin.routes.js';
import orderRoutes from '../../modules/order/order.routes.js';
import pricingAdminRoutes from '../../modules/pricing/pricing.admin.routes.js';
import catalogRoutes from '../../modules/pricing/catalog.routes.js';
import pricingRoutes from '../../modules/pricing/pricing.routes.js';
import { apiRateLimiter } from '../../shared/middleware/rate-limit.js';

/**
 * API v1 router.
 *
 * This is the composition root for the HTTP surface: the only place that knows
 * which module is mounted at which path. Modules expose a router and know
 * nothing about their mount point, so moving or versioning an endpoint is a
 * change here and nowhere else.
 *
 * Modules are mounted as they are built. Still to come:
 *
 *   /dispatch      /deliveries    /payments
 *   /wallets       /credit        /coupons
 *   /notifications /audit
 *
 * They are intentionally NOT registered yet — an endpoint appears here only
 * once it is genuinely implemented, so this file is always an accurate
 * description of what the API actually serves.
 */
const router = Router();

/**
 * Cross-module wiring.
 *
 * Corporate contributes a login gate that Identity enforces (BR-203, BR-209).
 * It is installed HERE rather than as an import side effect inside either
 * module, because the composition root is the only place that legitimately
 * knows both exist — and a side-effect import is an invisible dependency that
 * breaks the moment someone reorders imports.
 */
installCorporateLoginGate();

// Applies to everything below it. Health is exempted inside the limiter itself.
// Authentication routes add their own, far stricter limiter on top.
router.use(apiRateLimiter);

router.use('/health', healthRoutes);
router.use('/auth', identityRoutes);
router.use('/customers', customerRoutes);
router.use('/corporates', corporateRoutes);
router.use('/quotes', pricingRoutes);
// What a customer may order. Lets the apps DISCOVER the product instead of
// being compiled with its id.
router.use('/products', catalogRoutes);
router.use('/orders', orderRoutes);
/**
 * The driver app. Its own prefix, gated on the DRIVER principal, and scoped
 * entirely to the caller — no route here takes a driver identifier.
 */
router.use('/driver', driverRoutes);
router.use('/admin/corporates', corporateAdminRoutes);
/**
 * Cross-customer reads. Its own prefix rather than the shared /admin routers
 * below, for the same reason as orders: `/customers/:id` must not have to
 * coexist with Fleet's `/vehicles/:id` patterns in one namespace.
 */
router.use('/admin/customers', customerAdminRoutes);
/**
 * Mounted at its own prefix rather than under the shared /admin routers below,
 * because `/orders/:id/...` would otherwise have to coexist with Fleet's
 * `/vehicles/:id/...` patterns in one namespace. A distinct prefix keeps the
 * two sets of parameterised paths from ever being able to shadow each other.
 */
router.use('/admin/orders', orderAdminRoutes);
/**
 * Pricing and Fleet both mount at /admin, because each spans several nouns
 * (/products, /prices, /taxes … and /drivers, /vehicles, /shifts) that belong
 * to one bounded context. Their path sets are disjoint, so the ordering here is
 * not load-bearing for correctness - but both routers authenticate in a `use`,
 * which means a request for a fleet path passes through Pricing's auth check
 * before falling through. Same verdict either way; worth knowing when reading a
 * trace.
 *
 * Registered LAST so their `/:id` patterns cannot shadow a more specific path
 * on a sibling router.
 */
router.use('/admin', pricingAdminRoutes);
router.use('/admin', fleetAdminRoutes);

export default router;
