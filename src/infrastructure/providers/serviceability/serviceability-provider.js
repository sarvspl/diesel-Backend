/**
 * ServiceabilityProvider - "can we deliver to this point?"
 *
 * ARCHITECTURE ONLY in this phase. There is no maps integration, no geofence
 * and no zone table; the sole implementation answers yes to everything.
 *
 * The interface is owned by the platform rather than shaped around any vendor
 * (ADR-011), so the eventual PostGIS/Google Maps implementation slots in
 * without touching a caller.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not the authoritative check. BR-504 requires serviceability to be validated
 * at QUOTE time, because zones, operating hours and fleet coverage change
 * between saving an address and ordering against it. The result stored on an
 * address is a cache for UI hinting, and the quote engine must re-check
 * (docs/02 §5).
 *
 * @typedef {object} ServiceabilityQuery
 * @property {number|string} latitude
 * @property {number|string} longitude
 * @property {string} [pincode]
 * @property {string} [city]
 *
 * @typedef {object} ServiceabilityResult
 * @property {boolean} serviceable
 * @property {string}  provider
 * @property {string|null} [zoneId]      Populated once zones exist.
 * @property {string|null} [reasonCode]  Why not, when serviceable is false.
 * @property {string|null} [nearestServicedArea] For the "not here yet" screen.
 *
 * @typedef {object} ServiceabilityProvider
 * @property {string} name
 * @property {(query: ServiceabilityQuery) => Promise<ServiceabilityResult>} check
 */

/** Reasons a future implementation may return. Defined now so callers can branch. */
export const SERVICEABILITY_REASON = Object.freeze({
  OUTSIDE_SERVICE_AREA: 'OUTSIDE_SERVICE_AREA',
  OUTSIDE_SERVICE_HOURS: 'OUTSIDE_SERVICE_HOURS',
  NO_VEHICLE_COVERAGE: 'NO_VEHICLE_COVERAGE',
});
