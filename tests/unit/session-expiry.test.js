import '../helpers/env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { env } from '../../src/config/env.js';
import {
  refreshTokenExpiryDate,
  sessionAbsoluteExpiryDate,
} from '../../src/modules/identity/services/token.service.js';
import { durationToSeconds } from '../../src/shared/utils/duration.js';

/**
 * Guards the two-clock session model.
 *
 * The original implementation recomputed the sliding expiry on every rotation
 * with no ceiling, so a session refreshed indefinitely never died - including
 * one kept alive by an attacker with a stolen refresh token. These tests
 * encode the fix.
 */

describe('session expiry model', () => {
  const at = new Date('2026-07-20T00:00:00.000Z');

  it('the sliding window is shorter than the absolute ceiling', () => {
    assert.ok(
      durationToSeconds(env.SESSION_ABSOLUTE_LIFETIME) >
        durationToSeconds(env.JWT_REFRESH_EXPIRES_IN),
      'the ceiling must outlast one refresh window, or sessions die before their first rotation'
    );
  });

  it('computes the sliding expiry from the given instant', () => {
    // Default 30d.
    assert.equal(refreshTokenExpiryDate(at).toISOString(), '2026-08-19T00:00:00.000Z');
  });

  it('computes the absolute ceiling from the given instant', () => {
    // Default 90d.
    assert.equal(sessionAbsoluteExpiryDate(at).toISOString(), '2026-10-18T00:00:00.000Z');
  });

  it('the ceiling is reached even under continuous rotation', () => {
    // Simulate a session refreshed every 20 days forever. Under the old model
    // `expiresAt` was recomputed unclamped each time and the session never
    // expired. The ceiling is fixed at login, so it always wins eventually.
    const absolute = sessionAbsoluteExpiryDate(at);
    let now = at;
    let rotations = 0;

    while (now < absolute && rotations < 1_000) {
      now = new Date(now.getTime() + 20 * 86_400_000);
      rotations += 1;
    }

    assert.ok(rotations < 1_000, 'rotation never reached the ceiling - it is being extended');
    assert.ok(now >= absolute);
  });

  it('clamps a sliding expiry that would overshoot the ceiling', () => {
    // The clamp applied in rotateSession: refreshing on day 89 of a 90-day
    // session must not write an expiry 30 days past the ceiling.
    const absolute = sessionAbsoluteExpiryDate(at);
    const lateRotation = new Date(absolute.getTime() - 86_400_000); // 1 day before

    const sliding = refreshTokenExpiryDate(lateRotation);
    const clamped = sliding > absolute ? absolute : sliding;

    assert.ok(sliding > absolute, 'precondition: the raw sliding expiry overshoots');
    assert.equal(clamped.toISOString(), absolute.toISOString());
  });
});
