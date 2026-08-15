// Haversine — meters between two lat/lng pairs.
// Ported from empowertours-workforce/lib/geo/distance.ts so the hunt and the
// Ranch Quest race agree on what "10 meters away" means.

export interface LatLng {
  lat: number;
  lng: number;
}

export function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  // CLAMP. `h` is algebraically in [0, 1], but floating point does not know
  // that: for near-antipodal points the rounding error pushes it just over.
  // Measured, not theorised — {lat:-59.87837783617908, lng:-74.37065036240149}
  // against {lat:59.87837783617891, lng:105.62934963759851} yields
  // h = 1.0000000000000004, so Math.sqrt(h) = 1.0000000000000002 and
  // Math.asin of that is NaN.
  //
  // A NaN distance is a security bug, not a cosmetic one: NaN fails EVERY
  // comparison, so `distance > radius` is false and a naive geofence written
  // as "if too far, skip" lets the point through as if it were a bullseye.
  // Callers still guard with Number.isFinite (see lib/hunt/validator.ts) —
  // NaN inputs must stay NaN out — but the arithmetic itself must not invent
  // one from two perfectly valid coordinates.
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The ONLY correct polarity for a geofence test: state the accept condition
 * and negate it, never state the reject condition. `distance <= radius` is
 * false for NaN, so an unusable distance falls out as "not inside" instead of
 * silently passing the way `!(distance > radius)` would.
 *
 * `Number.isFinite` is belt-and-braces on top of that: it makes the intent
 * explicit for the next person to read this, rather than leaving the safety of
 * the whole thing resting on IEEE-754 comparison trivia.
 */
export function withinGeofence(
  player: LatLng,
  target: LatLng & { radiusMeters: number },
): { ok: boolean; distance: number } {
  const distance = haversineMeters(player, target);
  const ok = Number.isFinite(distance) && distance <= target.radiusMeters;
  return { ok, distance };
}
