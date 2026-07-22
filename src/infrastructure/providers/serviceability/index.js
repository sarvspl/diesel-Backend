import { alwaysServiceableProvider } from './always-serviceable-provider.js';

/**
 * Serviceability provider selection.
 *
 * The single place that knows which implementation is active. Callers depend on
 * the interface and never import a concrete provider, so adding a zone-based or
 * maps-backed implementation is one entry here.
 *
 * No env switch yet: there is exactly one implementation, and a configuration
 * knob with a single valid value is noise. It becomes `env.SERVICEABILITY_PROVIDER`
 * when a second one exists.
 */
export const getServiceabilityProvider = () => alwaysServiceableProvider;

export { SERVICEABILITY_REASON } from './serviceability-provider.js';
