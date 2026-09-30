import '../helpers/env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Set before the config module loads (each test file runs in its own process).
process.env.GOOGLE_MAPS_SERVER_KEY = 'test-key';
const { computeRoute, straightLineMeters } =
  await import('../../src/infrastructure/providers/maps/google-routes.js');

const origin = { latitude: 18.6298, longitude: 73.8131 };
const destination = { latitude: 18.5204, longitude: 73.8567 };

describe('Google Routes adapter', () => {
  it('maps a computeRoutes answer and sends the key in a header, not the URL', async () => {
    let seen;
    const http = async (url, init) => {
      seen = { url, init };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          routes: [
            { distanceMeters: 14250, duration: '1680s', polyline: { encodedPolyline: 'abc' } },
          ],
        }),
      };
    };

    const route = await computeRoute({ origin, destination, http });

    assert.deepEqual(route, { distanceMeters: 14250, durationSeconds: 1680, polyline: 'abc' });
    assert.equal(seen.init.headers['X-Goog-Api-Key'], 'test-key');
    assert.ok(!String(seen.url).includes('test-key'));
  });

  it('returns null instead of throwing when Google fails', async () => {
    const http = async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: 'API key not valid' } }),
    });

    assert.equal(
      await computeRoute({ origin: { latitude: 1, longitude: 1 }, destination, http }),
      null
    );
  });

  it('computes a sane straight-line distance', () => {
    const m = straightLineMeters(origin, destination);
    assert.ok(m > 12_000 && m < 14_000, `got ${m}`);
  });
});
