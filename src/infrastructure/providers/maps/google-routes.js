import { env } from '../../../config/env.js';
import { createLogger } from '../../../shared/logger/index.js';

const log = createLogger({ module: 'maps.google-routes' });

/**
 * Road route between two points, via Google Routes API (computeRoutes).
 *
 * Called from the SERVER, never from the apps: a web-service key cannot be
 * locked to an Android package, so shipping it in an APK would let anyone
 * extract it and spend on our account. The server key is restricted to the
 * server's outbound IP instead.
 *
 * Returns null — never throws — when there is no key or Google fails. A map
 * without a road line (the apps fall back to a straight line) is a degraded
 * screen, not a broken delivery.
 *
 * CACHED in memory: every open tracking screen polls, and each call is billed.
 * Positions are rounded to ~100 m, so a tanker parked at a signal reuses the
 * last answer instead of paying for an identical route.
 *
 * @returns {Promise<{ distanceMeters: number, durationSeconds: number, polyline: string } | null>}
 */

const ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const cache = new Map();
const MAX_CACHE = 500;

const round = (n) => Math.round(n * 1000) / 1000; // ~110 m

export const isRoutingEnabled = () => Boolean(env.GOOGLE_MAPS_SERVER_KEY);

export const computeRoute = async ({ origin, destination, http = fetch }) => {
  if (!env.GOOGLE_MAPS_SERVER_KEY) return null;

  const key = [
    round(origin.latitude),
    round(origin.longitude),
    round(destination.latitude),
    round(destination.longitude),
  ].join(',');
  const hit = cache.get(key);

  if (hit && Date.now() - hit.at < env.ROUTE_CACHE_SECONDS * 1000) return hit.value;

  try {
    const res = await http(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': env.GOOGLE_MAPS_SERVER_KEY,
        'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline',
      },
      body: JSON.stringify({
        origin: { location: { latLng: origin } },
        destination: { location: { latLng: destination } },
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_AWARE',
      }),
      signal: AbortSignal.timeout(8000),
    });

    const body = await res.json().catch(() => null);
    const route = body?.routes?.[0];

    if (!res.ok || !route) {
      log.warn({ status: res.status, error: body?.error?.message }, 'Google route failed');
      return null;
    }

    const value = {
      distanceMeters: route.distanceMeters ?? 0,
      // "1234s"
      durationSeconds: Number.parseInt(String(route.duration ?? '0'), 10) || 0,
      polyline: route.polyline?.encodedPolyline ?? '',
    };

    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), value });

    return value;
  } catch (err) {
    log.warn({ err: err.message }, 'Google route request failed');
    return null;
  }
};

/** Straight-line distance in metres. Used when there is no road route. */
export const straightLineMeters = (a, b) => {
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;

  return Math.round(R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
};
