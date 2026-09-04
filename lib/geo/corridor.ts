import { destinationPoint } from "@/lib/hunt/spawn";
import type { LatLng } from "@/lib/geo/distance";
import { haversineMeters } from "@/lib/geo/distance";
import type { Ring } from "@/lib/geo/polygon";

// ---------------------------------------------------------------------------
// Turning real surveyed footpaths into walkable rings.
//
// OpenStreetMap describes a path as a LINE, and `isWalkable` asks whether a
// point is inside a POLYGON. The obvious move is to buffer the line into a
// corridor polygon, which means offsetting both sides, mitring the joins and
// unioning overlaps — a lot of geometry to get subtly wrong.
//
// It is also unnecessary. `isWalkable` returns true when a point falls in ANY
// include ring, so a chain of small rings laid along the path already IS the
// corridor. The union happens for free at query time, and every ring is a
// shape simple enough to check by eye.
//
// ## Why real map data rather than a generated one
//
// These rings decide where a person is sent to walk. OSM footpaths were
// surveyed by people who went there; a plausible-looking path that does not
// exist sends somebody into a road. That is the whole reason this reads a map
// instead of inventing one.
// ---------------------------------------------------------------------------

/** Vertices per ring. Eight is round enough at this scale and cheap to test. */
const RING_VERTICES = 8;

/**
 * Thin a path down to points at least `spacingM` apart.
 *
 * OSM nodes cluster wherever a road bends, so a raw way can carry hundreds of
 * points within a few metres of each other. Every one would become a Zone row
 * and a polygon test on every placement attempt, for a corridor no wider than
 * the ones beside it.
 *
 * The first and last points are always kept: dropping an endpoint shortens the
 * walkable area at exactly the junction where it is most likely to matter.
 */
export function decimate(
  points: readonly LatLng[],
  spacingM: number,
): LatLng[] {
  if (spacingM <= 0) throw new RangeError("spacingM must be positive");
  if (points.length === 0) return [];

  const kept: LatLng[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    if (haversineMeters(kept[kept.length - 1], points[i]) >= spacingM) {
      kept.push(points[i]);
    }
  }
  if (points.length > 1) {
    const last = points[points.length - 1];
    // Only if it is not effectively the point already kept, or the ring would
    // be a duplicate of its neighbour.
    if (haversineMeters(kept[kept.length - 1], last) > 1) kept.push(last);
  }
  return kept;
}

/**
 * A closed ring approximating a circle of `radiusM` around a point.
 *
 * The first vertex is NOT repeated at the end — `pointInRing` closes the ring
 * implicitly, and repeating it produces a zero-length edge.
 */
export function ringAround(centre: LatLng, radiusM: number): Ring {
  if (radiusM <= 0) throw new RangeError("radiusM must be positive");
  // Built as a mutable array and returned as a Ring — Ring is readonly, which
  // is the right shape for a value nothing downstream should be editing.
  const ring: LatLng[] = [];
  for (let i = 0; i < RING_VERTICES; i++) {
    ring.push(destinationPoint(centre, (360 / RING_VERTICES) * i, radiusM));
  }
  return ring;
}

export interface CorridorOptions {
  /** Half-width of the walkable strip. */
  radiusM: number;
  /**
   * Distance between ring centres. Must be under `2 * radiusM` or consecutive
   * rings leave gaps a spawn can land in — a hole in the middle of a path,
   * which reads to a player as the drop being unreachable.
   */
  spacingM: number;
}

/**
 * Rings covering one path.
 *
 * Refuses a spacing that would leave gaps rather than quietly producing a
 * dotted corridor. Overlapping is fine and free; a gap is a bug you only find
 * when somebody is standing next to a spawn they cannot reach.
 */
export function corridorRings(
  path: readonly LatLng[],
  opts: CorridorOptions,
): Ring[] {
  if (opts.spacingM >= 2 * opts.radiusM) {
    throw new RangeError(
      `spacingM ${opts.spacingM} must be under 2 * radiusM (${2 * opts.radiusM}) or the corridor has gaps`,
    );
  }
  return decimate(path, opts.spacingM).map((p) => ringAround(p, opts.radiusM));
}
