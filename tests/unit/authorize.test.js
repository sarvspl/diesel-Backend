import '../helpers/env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  signAccessToken,
  signRefreshToken,
} from '../../src/modules/identity/services/token.service.js';
import { authenticate } from '../../src/shared/middleware/authenticate.js';
import {
  requireAnyPermission,
  requirePermission,
  requirePrincipal,
  requireRole,
} from '../../src/shared/middleware/authorize.js';
import { requireOwnership, requireSelf } from '../../src/shared/middleware/ownership.js';

/** Minimal Express request double. */
const makeReq = ({ auth = null, headers = {}, params = {} } = {}) => ({
  auth,
  params,
  path: '/test',
  get: (name) => headers[name.toLowerCase()],
});

/** Runs a middleware and reports what it passed to next(). */
const run = async (middleware, req) => {
  let captured;
  await middleware(req, {}, (error) => {
    captured = error;
  });
  return captured;
};

const customer = {
  userId: 'u-1',
  principal: 'CUSTOMER',
  sessionId: 's-1',
  roles: ['CUSTOMER'],
  permissions: ['user.read.self', 'session.read.self'],
};

const admin = {
  userId: 'u-2',
  principal: 'ADMIN',
  sessionId: 's-2',
  roles: ['ADMIN'],
  permissions: ['user.read.self', 'user.read.any', 'session.revoke.any'],
};

describe('authenticate', () => {
  it('rejects a request with no Authorization header', async () => {
    const error = await run(authenticate, makeReq());

    assert.equal(error.code, 'TOKEN_MISSING');
    assert.equal(error.statusCode, 401);
  });

  it('rejects a non-Bearer Authorization header', async () => {
    const error = await run(authenticate, makeReq({ headers: { authorization: 'Basic abc123' } }));

    assert.equal(error.code, 'TOKEN_INVALID');
  });

  it('populates req.auth from a valid token', async () => {
    const token = signAccessToken({
      userId: 'u-1',
      principal: 'CUSTOMER',
      sessionId: 's-1',
      roles: ['CUSTOMER'],
      permissions: ['user.read.self'],
    });

    const req = makeReq({ headers: { authorization: `Bearer ${token}` } });
    const error = await run(authenticate, req);

    assert.equal(error, undefined);
    assert.equal(req.auth.userId, 'u-1');
    assert.equal(req.auth.principal, 'CUSTOMER');
    assert.deepEqual(req.auth.permissions, ['user.read.self']);
  });

  it('rejects a refresh token used as an access token', async () => {
    const refresh = signRefreshToken({ userId: 'u-1', sessionId: 's-1' });
    const error = await run(
      authenticate,
      makeReq({ headers: { authorization: `Bearer ${refresh}` } })
    );

    assert.equal(error.statusCode, 401);
  });
});

describe('requirePermission', () => {
  it('allows a caller holding the permission', async () => {
    const error = await run(requirePermission('user.read.self'), makeReq({ auth: customer }));

    assert.equal(error, undefined);
  });

  it('denies a caller missing the permission', async () => {
    const error = await run(requirePermission('user.read.any'), makeReq({ auth: customer }));

    assert.equal(error.statusCode, 403);
    assert.equal(error.code, 'INSUFFICIENT_PERMISSIONS');
  });

  it('does not disclose which permission was missing', async () => {
    const error = await run(requirePermission('role.manage'), makeReq({ auth: customer }));

    // Naming the missing grant would map the permission model for an attacker.
    assert.ok(!error.message.includes('role.manage'));
    assert.equal(error.details, undefined);
  });

  it('requires ALL listed permissions, not any', async () => {
    const error = await run(
      requirePermission('user.read.self', 'user.read.any'),
      makeReq({ auth: customer })
    );

    assert.equal(error.statusCode, 403);
  });

  it('returns 401, not 403, when unauthenticated', async () => {
    // The distinction matters: 401 means "refresh and retry", 403 means "stop".
    // Conflating them makes clients retry-loop against a token that was never
    // the problem.
    const error = await run(requirePermission('user.read.self'), makeReq());

    assert.equal(error.statusCode, 401);
    assert.equal(error.code, 'TOKEN_MISSING');
  });
});

describe('requireAnyPermission', () => {
  it('allows when one of the alternatives is held', async () => {
    const error = await run(
      requireAnyPermission('session.read.any', 'session.read.self'),
      makeReq({ auth: customer })
    );

    assert.equal(error, undefined);
  });

  it('denies when none is held', async () => {
    const error = await run(
      requireAnyPermission('role.manage', 'role.assign'),
      makeReq({ auth: customer })
    );

    assert.equal(error.statusCode, 403);
  });
});

describe('requirePrincipal', () => {
  it('allows a matching account kind', async () => {
    const error = await run(requirePrincipal('CUSTOMER'), makeReq({ auth: customer }));

    assert.equal(error, undefined);
  });

  it('blocks a driver token on a customer-only endpoint', async () => {
    // Surface separation, not authorisation: separate accounts per principal
    // is the whole point of ADR-016.
    const driver = { ...customer, principal: 'DRIVER' };
    const error = await run(requirePrincipal('CUSTOMER'), makeReq({ auth: driver }));

    assert.equal(error.statusCode, 403);
    assert.equal(error.code, 'WRONG_PRINCIPAL');
  });
});

describe('requireRole', () => {
  it('allows a matching role', async () => {
    const error = await run(requireRole('ADMIN'), makeReq({ auth: admin }));

    assert.equal(error, undefined);
  });

  it('denies a non-matching role', async () => {
    const error = await run(requireRole('SUPER_ADMIN'), makeReq({ auth: admin }));

    assert.equal(error.statusCode, 403);
  });
});

describe('requireOwnership', () => {
  const resource = (ownerId) => async () => ({ ownerId });

  it('allows the owner through', async () => {
    const error = await run(
      requireOwnership({ resolveOwner: resource('u-1') }),
      makeReq({ auth: customer })
    );

    assert.equal(error, undefined);
  });

  it("returns 404, not 403, for someone else's resource", async () => {
    // A 403 would confirm the resource exists, which is itself a disclosure.
    const req = makeReq({ auth: customer });
    const error = await run(requireOwnership({ resolveOwner: resource('u-999') }), req);

    assert.equal(error.statusCode, 404);
  });

  it('returns the same 404 when the resource does not exist', async () => {
    const missing = await run(
      requireOwnership({ resolveOwner: async () => null }),
      makeReq({ auth: customer })
    );
    const notOwned = await run(
      requireOwnership({ resolveOwner: resource('u-999') }),
      makeReq({ auth: customer })
    );

    // Indistinguishable by design.
    assert.equal(missing.statusCode, notOwned.statusCode);
    assert.equal(missing.message, notOwned.message);
  });

  it('lets an override permission bypass ownership', async () => {
    const req = makeReq({ auth: admin });
    const error = await run(
      requireOwnership({
        resolveOwner: resource('u-999'),
        overridePermission: 'session.revoke.any',
      }),
      req
    );

    assert.equal(error, undefined);
    assert.equal(req.ownership.viaOverride, true);
  });

  it('does not load the resource when the override applies', async () => {
    // An administrator must not trigger a failed lookup on a record they are
    // entitled to act on regardless of owner.
    let called = false;
    const req = makeReq({ auth: admin });

    await run(
      requireOwnership({
        resolveOwner: async () => {
          called = true;
          return null;
        },
        overridePermission: 'session.revoke.any',
      }),
      req
    );

    assert.equal(called, false);
  });

  it('requires authentication', async () => {
    const error = await run(requireOwnership({ resolveOwner: resource('u-1') }), makeReq());

    assert.equal(error.statusCode, 401);
  });
});

describe('requireSelf', () => {
  it('allows a caller acting on their own id', async () => {
    const req = makeReq({ auth: customer, params: { userId: 'u-1' } });
    const error = await run(requireSelf(), req);

    assert.equal(error, undefined);
  });

  it("denies a caller acting on someone else's id", async () => {
    const req = makeReq({ auth: customer, params: { userId: 'u-999' } });
    const error = await run(requireSelf(), req);

    assert.equal(error.statusCode, 403);
    assert.equal(error.code, 'NOT_RESOURCE_OWNER');
  });

  it('lets an override permission act on any id', async () => {
    const req = makeReq({ auth: admin, params: { userId: 'u-999' } });
    const error = await run(requireSelf({ overridePermission: 'user.read.any' }), req);

    assert.equal(error, undefined);
  });
});
