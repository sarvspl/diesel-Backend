import { env } from '../../../config/env.js';

import { createDezel4uProvider } from './dezel4u-flow-meter-provider.js';
import { mockFlowMeterProvider } from './mock-flow-meter-provider.js';

/**
 * Flow-meter provider selection.
 *
 * The single place that knows which implementation is active. Callers depend on
 * the interface in flow-meter-provider.js and never import a concrete provider,
 * so adding another vendor is one branch here plus one value in the
 * FLOW_METER_PROVIDER env enum (docs/16 §4).
 */

let dezel4u = null;

const build = (name) => {
  switch (name) {
    case 'mock':
      return mockFlowMeterProvider;
    case 'dezel4u':
      // Constructed once, lazily: it needs FYFT_SOURCE_CODE, which is absent in
      // every environment that runs `mock`/`manual`, and holds a cached token.
      dezel4u ??= createDezel4uProvider({
        sourceCode: env.FYFT_SOURCE_CODE,
        baseUrl: env.FYFT_BASE_URL,
      });
      return dezel4u;
    default:
      throw new Error(`Unknown flow-meter provider: ${name}`);
  }
};

/**
 * The active flow-meter provider, or NULL when none is configured.
 *
 * `manual` (the default) means there is no device integration: callers use the
 * driver-typed path with its photo requirement, exactly as today. Returning
 * null rather than throwing is deliberate — "no meter integration" is a valid,
 * common state, not an error.
 *
 * @returns {import('./flow-meter-provider.js').FlowMeterProvider | null}
 */
export const getFlowMeterProvider = () => {
  if (env.FLOW_METER_PROVIDER === 'manual') return null;
  return build(env.FLOW_METER_PROVIDER);
};

export * from './flow-meter-provider.js';
