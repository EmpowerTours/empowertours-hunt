import { haversineMeters, type LatLng } from "@/lib/geo/distance";

/* ---------------------------------------------------------------------------
   Client-side geometry — for plotting SPAWNS only.

   Distance is re-used from lib/geo/distance rather than re-derived, so the
   radar and the verifier never disagree about what "24 meters away" means.

   There is no cache equivalent of any function in this file and there cannot
   be: the client is never given a cache coordinate, so it has nothing to
   compute a bearing from. That is the point.
--------------------------------------------------------------------------- */

export { haversineMeters };
export type { LatLng };

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/**
 * Initial great-circle bearing from `from` to `to`, in degrees clockwise from
 * true north, normalised to [0, 360).
 */
export function bearingDegrees(from: LatLng, to: LatLng): number {
  const lat1 = from.lat * RAD;
  const lat2 = to.lat * RAD;
  const dLng = (to.lng - from.lng) * RAD;

  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);

  return (Math.atan2(y, x) * DEG + 360) % 360;
}

export interface ScopePoint {
  /** SVG x in a viewBox centred on 0,0 with the rim at `rimRadius`. */
  x: number;
  y: number;
  /** True when the target is past the current range and clamped to the rim. */
  offScope: boolean;
}

/**
 * Project a bearing + distance onto the scope. North is up, so the SVG y axis
 * (which grows downward) is negated.
 */
export function projectToScope(
  bearingDeg: number,
  distanceMeters: number,
  rangeMeters: number,
  rimRadius: number,
): ScopePoint {
  // Reject-by-default arithmetic: a non-finite range would produce NaN
  // coordinates and silently drop the blip out of the DOM.
  const range =
    rangeMeters > 0 && Number.isFinite(rangeMeters) ? rangeMeters : 1;
  const raw = Number.isFinite(distanceMeters) ? distanceMeters / range : 1;
  const offScope = raw > 1;
  const unit = Math.min(raw, 1);
  const theta = bearingDeg * RAD;
  return {
    x: Math.sin(theta) * unit * rimRadius,
    y: -Math.cos(theta) * unit * rimRadius,
    offScope,
  };
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

export function compassPoint(bearingDeg: number): string {
  const i = Math.round((((bearingDeg % 360) + 360) % 360) / 45) % 8;
  return COMPASS[i];
}

/**
 * A round-ish scope range that comfortably contains everything plotted.
 * Snapped to a familiar ladder so the ring labels stay readable.
 */
const RANGE_LADDER = [100, 200, 300, 500, 750, 1000, 1500, 2500, 5000];

export function pickRange(maxDistanceMeters: number, fallback: number): number {
  if (!Number.isFinite(maxDistanceMeters) || maxDistanceMeters <= 0) {
    return fallback;
  }
  const needed = maxDistanceMeters * 1.15;
  for (const step of RANGE_LADDER) {
    if (needed <= step) return step;
  }
  return RANGE_LADDER[RANGE_LADDER.length - 1];
}
