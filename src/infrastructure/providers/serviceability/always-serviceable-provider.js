/**
 * Placeholder serviceability provider: everything is serviceable.
 *
 * Exists so the address flow is complete end to end before zones, PostGIS or a
 * maps vendor arrive. The alternative - callers doing `if (provider)` around
 * every check - means the real integration has to unpick conditionals scattered
 * across the module.
 *
 * DELIBERATELY NOT a stub that throws: an address must be saveable today.
 *
 * @type {import('./serviceability-provider.js').ServiceabilityProvider}
 */
export const alwaysServiceableProvider = {
  name: 'always-serviceable',

  async check() {
    return {
      serviceable: true,
      provider: this.name,
      zoneId: null,
      reasonCode: null,
      nearestServicedArea: null,
    };
  },
};
