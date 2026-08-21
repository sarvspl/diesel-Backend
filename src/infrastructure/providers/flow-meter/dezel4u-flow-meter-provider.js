import { createLogger } from '../../../shared/logger/index.js';

import {
  FLOW_METER_ERROR,
  FLOW_METER_STATUS,
  FlowMeterError,
  MEASUREMENT_MODEL,
} from './flow-meter-provider.js';

const log = createLogger({ module: 'flow-meter.dezel4u' });

/**
 * dezel4u / FYFT bowser-monitoring adapter.
 *
 * Their platform reports **current tank stock** (litres in the bowser now),
 * plus GPS and movement — not a flow-meter totaliser. So every reading is
 * `measurement: STOCK`, and the delivery calculation upstream uses
 * start − end (see `deliveredFromStock`).
 *
 * Auth is two-legged:
 *   1. POST `source_code` → `fetch_jwt.php` → a JWT (RS256), valid ~60 h and
 *      bound to our server's IP.
 *   2. Every data call carries `Authentication: <source_code>` and
 *      `X-Verify: <jwt>`.
 * The JWT is cached and refreshed on expiry or on an auth error.
 *
 * `http` and `now` are injectable so the mapping can be unit-tested against the
 * vendor's own sample payloads without a live, IP-bound endpoint.
 *
 * @returns {import('./flow-meter-provider.js').FlowMeterProvider}
 */
export const createDezel4uProvider = ({
  sourceCode,
  baseUrl = 'https://www.dezel4u.com/go_fyft',
  http = fetch,
  now = () => new Date(),
  // Refresh this many ms before the JWT actually expires, to avoid a race.
  refreshSkewMs = 60_000,
}) => {
  if (!sourceCode) {
    throw new Error('dezel4u flow-meter provider requires a source code (FYFT_SOURCE_CODE)');
  }

  /** @type {{ token: string, expiresAt: number } | null} */
  let cached = null;

  const form = (obj) =>
    Object.entries(obj)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');

  /** exp from the JWT payload (seconds → ms), or a 60 h fallback if unreadable. */
  const expiryOf = (token) => {
    try {
      const [, payload] = token.split('.');
      const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (typeof exp === 'number') return exp * 1000;
    } catch {
      /* fall through */
    }
    return now().getTime() + 60 * 60 * 60 * 1000;
  };

  const fetchToken = async () => {
    const res = await http(`${baseUrl}/fetch_jwt.php`, {
      method: 'POST',
      headers: { 'Content-type': 'application/x-www-form-urlencoded' },
      body: form({ source_code: sourceCode }),
    });

    const body = await res.json().catch(() => null);

    if (!res?.ok || body?.result !== true || !body?.token) {
      throw new FlowMeterError(
        FLOW_METER_ERROR.AUTH_FAILED,
        body?.msg ?? 'FYFT authentication failed',
        { status: res?.status }
      );
    }

    cached = { token: body.token, expiresAt: expiryOf(body.token) };
    log.info({ expiresAt: new Date(cached.expiresAt).toISOString() }, 'FYFT token issued');
    return cached.token;
  };

  const getToken = async () => {
    if (cached && cached.expiresAt - refreshSkewMs > now().getTime()) return cached.token;
    return fetchToken();
  };

  /** "592.86L" | "592.86 L" | 592.86 → "592.860", or null if unparseable. */
  const parseStock = (value) => {
    const n = Number(String(value ?? '').replace(/[^\d.]/g, ''));
    return Number.isFinite(n) ? n.toFixed(3) : null;
  };

  const toReading = (body, registration) => ({
    measurement: MEASUREMENT_MODEL.STOCK,
    stockLitres: parseStock(body.stock),
    totalizerGross: null,
    totalizerNet: null,
    temperatureC: null,
    registerMax: null,
    // The vendor exposes no dispensing state; movement is separate telematics.
    status: FLOW_METER_STATUS.IDLE,
    location:
      Number.isFinite(Number(body.latitude)) && Number.isFinite(Number(body.longitude))
        ? { latitude: Number(body.latitude), longitude: Number(body.longitude) }
        : null,
    movementStatus: body.movement_status ?? null,
    // They send no timestamp — this is our receipt time. Freshness of the stock
    // figure itself must be validated against the vendor (docs/16).
    capturedAt: now(),
    deviceRef: registration,
    raw: body,
  });

  const readOnce = async ({ registration, token }) => {
    const res = await http(`${baseUrl}/check_bowstock.php`, {
      method: 'POST',
      headers: {
        'Content-type': 'application/x-www-form-urlencoded',
        Authentication: sourceCode,
        'X-Verify': token,
      },
      body: form({ vehicle: registration }),
    });

    if (!res?.ok) {
      throw new FlowMeterError(FLOW_METER_ERROR.DEVICE_OFFLINE, `FYFT HTTP ${res?.status}`, {
        status: res?.status,
      });
    }

    return res.json();
  };

  return {
    name: 'dezel4u',
    measurement: MEASUREMENT_MODEL.STOCK,

    async read({ registration }) {
      if (!registration) {
        throw new FlowMeterError(FLOW_METER_ERROR.VEHICLE_NOT_FOUND, 'No registration supplied');
      }

      let body = await readOnce({ registration, token: await getToken() });

      // Their error result is `false` or the string `"3"`, usually an expired /
      // rejected token. Refresh once and retry before giving up.
      const isAuthError = body?.result !== true && /auth/i.test(body?.msg ?? '');
      if (isAuthError) {
        cached = null;
        body = await readOnce({ registration, token: await getToken() });
      }

      if (body?.result !== true) {
        // Still failing: distinguish "we don't know this vehicle" from a
        // generic error where we can.
        const code = /not\s*match|auth/i.test(body?.msg ?? '')
          ? FLOW_METER_ERROR.AUTH_FAILED
          : FLOW_METER_ERROR.PROVIDER_ERROR;
        throw new FlowMeterError(code, body?.msg ?? 'FYFT read failed', { raw: body });
      }

      return toReading(body, registration);
    },
  };
};
