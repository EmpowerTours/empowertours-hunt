// Walkable-area geometry.
//
// WHY THIS EXISTS: `deriveSpawn` places a drop at a uniform random bearing and
// distance from the player. That is a point on an abstract disc, not on ground
// a human can stand on. Nothing stopped a spawn landing mid-river, inside
// someone's house, across a fence or on a highway — and the player then gets a
// countdown and a payout for reaching it. A map on the phone does not fix that;
// it only lets the player watch the system send them somewhere bad. The fix has
// to be at placement time, which is what this module is for.
//
// Caches do not need this: a human surveyed each one on foot, so they are
// walkable by construction. Only generated spawns can land anywhere.

import type { LatLng } from "./distance";

/**
 * A closed ring of vertices. The closing edge (last -> first) is implicit, so
 * do not repeat the first vertex at the end — a duplicated vertex is a
 * zero-length edge, which is harmless here but misleading to read.
 */
export type Ring = readonly LatLng[];

export interface WalkableArea {
  /**
   * Where spawns MAY land. Empty means "nowhere is approved", not "everywhere
   * is" — see `isWalkable`. A hunt that has not been surveyed yet must not
   * silently fall back to placing drops anywhere.
   */
  include: readonly Ring[];
  /** Hazards and no-go ground carved out of the hull. Wins over `include`. */
  exclude: readonly Ring[];
}

/**
 * A ring needs three distinct corners before it encloses anything.
 *
 * Structurally paranoid on purpose: these vertices arrive from a Prisma `Json`
 * column, which is typed as `unknown` in practice — nothing at the database
 * level stops a hand-edited row holding `{}`, `null`, or an array of strings.
 * Reaching `.every` on a non-array would throw inside placement, so the shape
 * is checked before the values are.
 */
function isUsableRing(ring: Ring): boolean {
  if (!Array.isArray(ring)) return false;
  if (ring.length < 3) return false;
  return ring.every(
    (v) =>
      typeof v === "object" &&
      v !== null &&
      Number.isFinite((v as LatLng).lat) &&
      Number.isFinite((v as LatLng).lng) &&
      Math.abs((v as LatLng).lat) <= 90 &&
      Math.abs((v as LatLng).lng) <= 180,
  );
}

/**
 * Crossing-number point-in-polygon.
 *
 * Returns false for a degenerate ring, a non-finite point, or a non-finite
 * vertex — every failure is "not inside", never "inside by default". This is
 * the same polarity rule as `withinGeofence`: state the accept condition, and
 * let anything unusable fall out as a reject.
 *
 * BOUNDARY POINTS ARE ARBITRARY, AND THAT IS FINE. A ray cast gives a
 * consistent but essentially coin-flip answer for a point lying exactly on an
 * edge. Chasing exactness there would be false precision: the input is a phone
 * GPS fix carrying 20-50m of error, so sub-metre edge behaviour is noise
 * against the measurement. Draw the polygons with margin instead — pull the
 * hull in from the riverbank, push exclusions out past the road — and the
 * ambiguous band never carries a decision that matters.
 *
 * LIMITATION: this is planar ray casting on raw degrees. It is correct for a
 * polygon that does not cross the antimeridian, which covers every hunt that
 * fits in a town. A ring spanning ±180 longitude would need splitting first.
 */
export function pointInRing(point: LatLng, ring: Ring): boolean {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return false;
  if (!isUsableRing(ring)) return false;

  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];

    // Does the edge straddle the point's latitude? Note this also guards the
    // division below: when a.lat === b.lat the two comparisons are equal, the
    // `&&` short-circuits, and we never divide by a zero span.
    const straddles = a.lat > point.lat !== b.lat > point.lat;
    if (!straddles) continue;

    const lngAtPointLat =
      ((b.lng - a.lng) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lng;

    if (point.lng < lngAtPointLat) inside = !inside;
  }
  return inside;
}

/** Cheap reject before the full ray cast. Also documents the ring's extent. */
export function ringBounds(ring: Ring): {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
} | null {
  if (!isUsableRing(ring)) return null;
  return {
    minLat: Math.min(...ring.map((v) => v.lat)),
    maxLat: Math.max(...ring.map((v) => v.lat)),
    minLng: Math.min(...ring.map((v) => v.lng)),
    maxLng: Math.max(...ring.map((v) => v.lng)),
  };
}

/**
 * May a spawn be placed here?
 *
 * Accept requires BOTH: inside at least one include ring, and inside no exclude
 * ring. Exclusions win, so a hazard carved out of the hull stays carved out
 * even if someone later redraws the hull over it.
 *
 * AN EMPTY `include` REJECTS EVERYTHING. That is deliberate and it is the
 * reason this returns a boolean rather than throwing: an unsurveyed hunt should
 * quietly place no spawns, not place them anywhere. If "no constraint" is ever
 * genuinely wanted, the caller decides that by not consulting this function at
 * all — it must never be inferred from empty configuration, because empty
 * configuration is what a half-finished survey looks like.
 */
export function isWalkable(point: LatLng, area: WalkableArea): boolean {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return false;

  for (const ring of area.exclude) {
    if (pointInRing(point, ring)) return false;
  }

  for (const ring of area.include) {
    if (pointInRing(point, ring)) return true;
  }

  return false;
}
