// Zone survey maths — the checks that stand between a walk around the village
// and a row that decides where money can land.
//
// Everything here is pure: no DB, no network, no clock. The API route and the
// survey UI both call these, so a ring that the operator sees accepted on the
// phone is the same ring the server accepts.

import { haversineMeters, type LatLng } from "@/lib/geo/distance";
import type { Ring } from "@/lib/geo/polygon";

/** Hand-traced rings have tens of vertices. Anything beyond this is a payload. */
export const MAX_RING_VERTICES = 500;

/**
 * A ring smaller than this is not a place, it is GPS noise with corners.
 *
 * Survey fixes are accepted down to 60m accuracy (`MAX_SURVEY_ACCURACY_M`), so
 * a 200 m² zone — about 14m on a side — is entirely inside the error bars of
 * the measurements that drew it. Saving one produces a zone whose true shape is
 * unknowable, which is worse than having none.
 */
export const MIN_RING_AREA_M2 = 200;

/**
 * ~25 km². A village hull is a few hundred thousand square metres at most, so
 * this catches the classic survey error: a stray vertex left at the previous
 * location, stretching the ring across a whole region.
 */
export const MAX_RING_AREA_M2 = 25_000_000;

const EARTH_R = 6_371_000;
const toRad = (d: number) => (d * Math.PI) / 180;

function isFiniteVertex(v: unknown): v is LatLng {
  return (
    typeof v === "object" &&
    v !== null &&
    Number.isFinite((v as LatLng).lat) &&
    Number.isFinite((v as LatLng).lng) &&
    Math.abs((v as LatLng).lat) <= 90 &&
    Math.abs((v as LatLng).lng) <= 180
  );
}

/** Total walked distance around the ring, including the implicit closing edge. */
export function ringPerimeterMeters(ring: Ring): number {
  if (!Array.isArray(ring) || ring.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    total += haversineMeters(ring[i], ring[(i + 1) % ring.length]);
  }
  return total;
}

/**
 * Enclosed area in square metres.
 *
 * Shoelace on a local equirectangular projection centred on the ring itself.
 * That is accurate to well under a percent for anything village-sized and
 * spares a spherical-excess formula nobody here needs — but it WOULD be wrong
 * for a ring spanning degrees of longitude or sitting near a pole, which is the
 * same limitation `pointInRing` carries and for the same reason.
 */
export function ringAreaSquareMeters(ring: Ring): number {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  if (!ring.every(isFiniteVertex)) return 0;

  const lat0 = toRad(ring.reduce((s, v) => s + v.lat, 0) / ring.length);
  const lng0 = ring.reduce((s, v) => s + v.lng, 0) / ring.length;

  const pts = ring.map((v) => ({
    x: EARTH_R * toRad(v.lng - lng0) * Math.cos(lat0),
    y: EARTH_R * toRad(v.lat - ring[0].lat),
  }));

  let twice = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    twice += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  }
  return Math.abs(twice) / 2;
}

/** Sign of the cross product — which side of ab does c fall on. */
function orientation(a: LatLng, b: LatLng, c: LatLng): number {
  const v = (b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng);
  if (v > 0) return 1;
  if (v < 0) return -1;
  return 0;
}

/** Proper segment crossing. Touching endpoints do not count — adjacent edges
 *  of a ring share one by construction. */
function segmentsCross(p1: LatLng, p2: LatLng, p3: LatLng, p4: LatLng): boolean {
  const d1 = orientation(p3, p4, p1);
  const d2 = orientation(p3, p4, p2);
  const d3 = orientation(p1, p2, p3);
  const d4 = orientation(p1, p2, p4);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/**
 * Does the ring cross itself?
 *
 * WHY THIS BLOCKS A SAVE: a figure-eight has no coherent inside. Ray casting
 * will happily answer for it, and the answer alternates between the lobes — so
 * half the zone silently behaves as its own opposite. An operator who traces a
 * route back on itself by mistake gets a zone that looks fine on a map and
 * places spawns in the wrong half of it.
 *
 * O(n²) over edge pairs, which is nothing for a ring somebody walked.
 */
export function isSimpleRing(ring: Ring): boolean {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  if (!ring.every(isFiniteVertex)) return false;

  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a1 = ring[i];
    const a2 = ring[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      // Skip adjacent edges, and skip the pair that wraps (last vs first).
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      if (segmentsCross(a1, a2, ring[j], ring[(j + 1) % n])) return false;
    }
  }
  return true;
}

export const RING_PROBLEMS = [
  "too_few_vertices",
  "too_many_vertices",
  "invalid_vertex",
  "self_intersecting",
  "too_small",
  "too_large",
] as const;
export type RingProblem = (typeof RING_PROBLEMS)[number];

export interface RingStats {
  vertices: number;
  perimeterMeters: number;
  areaSquareMeters: number;
}

export type RingValidation =
  | ({ ok: true } & RingStats)
  | { ok: false; problem: RingProblem; detail: string };

/**
 * Is this ring fit to save?
 *
 * Reject-by-default, in the order that gives the operator the most useful
 * complaint first: structure, then shape, then size.
 */
export function validateRing(ring: Ring): RingValidation {
  if (!Array.isArray(ring) || ring.length < 3) {
    return {
      ok: false,
      problem: "too_few_vertices",
      detail: `a zone needs at least 3 corners, got ${Array.isArray(ring) ? ring.length : 0}`,
    };
  }
  if (ring.length > MAX_RING_VERTICES) {
    return {
      ok: false,
      problem: "too_many_vertices",
      detail: `${ring.length} corners exceeds the ${MAX_RING_VERTICES} limit`,
    };
  }
  if (!ring.every(isFiniteVertex)) {
    return {
      ok: false,
      problem: "invalid_vertex",
      detail: "a corner is missing, non-numeric or off the globe",
    };
  }
  if (!isSimpleRing(ring)) {
    return {
      ok: false,
      problem: "self_intersecting",
      detail: "the outline crosses itself, so it has no single inside",
    };
  }

  const areaSquareMeters = ringAreaSquareMeters(ring);
  if (!(areaSquareMeters >= MIN_RING_AREA_M2)) {
    return {
      ok: false,
      problem: "too_small",
      detail: `${Math.round(areaSquareMeters)} m² is within GPS error; needs at least ${MIN_RING_AREA_M2} m²`,
    };
  }
  if (!(areaSquareMeters <= MAX_RING_AREA_M2)) {
    return {
      ok: false,
      problem: "too_large",
      detail: `${(areaSquareMeters / 1e6).toFixed(1)} km² is larger than a survey should cover — check for a stray corner`,
    };
  }

  return {
    ok: true,
    vertices: ring.length,
    perimeterMeters: ringPerimeterMeters(ring),
    areaSquareMeters,
  };
}
