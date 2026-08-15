// Proximity hints for free-roam collection.
//
// THE ATTACK THIS DEFENDS AGAINST
// A "hot/cold" hint is a distance oracle. Given a distance from three spoofed
// positions a player can trilaterate a cache and walk straight to it — or claim
// it without leaving the sofa. Since finds issue TURBO credit, that is a
// faucet, not just a spoiled game.
//
// The mitigation that used to be here was NOT enough, and it is worth being
// precise about why, because the fix looks like a small change:
//
//   Quantizing to bands hides the distance but not the BOUNDARY. With one
//   shared jitter multiplier applied to every band edge, the burning/hot
//   boundary is a perfect circle of a fixed (if unknown) radius centred on the
//   cache. Three points on a circle determine that circle. Binary-searching
//   each of three rays for the flip point costs ~40 queries and yields the
//   centre to sub-metre precision. Coarser bands do not help: a wider band
//   still has a sharp edge, and the edge is the oracle.
//
// So the defences here are, in order of how much they actually matter:
//
//   1. GRID SNAPPING (the important one). The player's position is snapped to
//      a ~50m cell before any distance is computed. Every probe inside a cell
//      returns the identical answer, so walking a boundary yields NOTHING —
//      the answer changes only when the player changes cell, and then it jumps
//      by a whole cell. The cell lattice is offset per player (and per server
//      secret, when one is configured), so probes cannot be aligned to the
//      lattice and two players cannot align their maps with each other.
//   2. NEAREST ONLY. One band for the closest unfound cache, never per-cache
//      bands. Otherwise each cache is an independent oracle and the whole set
//      falls at once.
//   3. PER-EDGE BOUNDARY JITTER. Each band edge gets its OWN offset derived
//      from (playerId, cacheId, band). One shared multiplier meant that
//      learning any single edge scaled all the others — the whole ladder was
//      one unknown. Deterministic, NOT random per request: a per-request random
//      offset averages away under repeated querying, which makes the oracle
//      sharper, not blurrier.
//   4. RATE LIMITING at the route (checkLimit("hint", ...)), and a HintRequest
//      row per probe so that a grid search is visible in the admin queue
//      rather than invisible.
//
// Nothing in this file touches the DB or the clock; the route supplies the
// per-player secret so this stays pure and testable.

import { haversineMeters, type LatLng } from "@/lib/geo/distance";

export const HINT_BANDS = ["burning", "hot", "warm", "cool", "cold"] as const;

export type HintBand = (typeof HINT_BANDS)[number];

/** Upper bound (meters, exclusive) for each band. `cold` is everything beyond. */
const BAND_EDGES: ReadonlyArray<{ band: HintBand; maxMeters: number }> = [
  { band: "burning", maxMeters: 75 },
  { band: "hot", maxMeters: 250 },
  { band: "warm", maxMeters: 1_000 },
  { band: "cool", maxMeters: 5_000 },
];

/**
 * Fraction by which a band edge may be shifted, per player+cache+edge.
 *
 * Bounded well under the ratio between adjacent nominal edges (the tightest is
 * 250/75 = 3.33, and the worst-case edge spread is 1.15/0.85 = 1.35), so
 * independently jittered edges can never cross and swap order.
 */
const JITTER_FRACTION = 0.15;

/** Side length of a snapping cell, in meters. */
export const HINT_GRID_METERS = 50;

/** Meters per degree of latitude. Close enough at this resolution. */
const METERS_PER_DEG_LAT = 111_320;

/**
 * Stable 32-bit hash (FNV-1a). Used only to derive deterministic offsets —
 * never as a secret or a MAC, so a non-cryptographic hash is the right tool.
 * Unpredictability, where it is wanted, comes from the caller's `gridSecret`,
 * not from this function.
 */
function stableHash(input: string): number {
  let h = 2_166_136_261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return h >>> 0;
}

/** Deterministic value in [0, 1). */
function unitHash(input: string): number {
  return stableHash(input) / 0x1_0000_0000;
}

/**
 * Deterministic multiplier in [1 - JITTER_FRACTION, 1 + JITTER_FRACTION] for
 * ONE band edge.
 *
 * The band name is part of the key. That is the whole fix: with a single
 * multiplier per (player, cache), every edge moved together and the ladder was
 * a one-parameter family — recover one edge and you have them all.
 */
function edgeMultiplier(
  playerId: string,
  cacheId: string,
  band: HintBand,
): number {
  const unit = unitHash(`${playerId}:${cacheId}:${band}`);
  return 1 + (unit * 2 - 1) * JITTER_FRACTION;
}

export function bandForDistance(
  distanceMeters: number,
  playerId: string,
  cacheId: string,
): HintBand {
  // Reject-by-default: a non-finite distance reports the LEAST informative
  // band rather than falling through a comparison. `NaN < x` is false for
  // every edge, so this is also what the loop below would do — stated
  // explicitly so it survives an edit.
  if (!Number.isFinite(distanceMeters)) return "cold";

  for (const edge of BAND_EDGES) {
    const bound = edge.maxMeters * edgeMultiplier(playerId, cacheId, edge.band);
    if (distanceMeters < bound) return edge.band;
  }
  return "cold";
}

/**
 * Snap a position to a ~50m cell whose lattice is offset per player.
 *
 * This is what turns the hint from a continuous oracle into a discrete one.
 * Two probes in the same cell are indistinguishable, so a binary search across
 * a band edge terminates at a cell, not at a point — and a cell is 50m wide.
 *
 * `gridSecret` should be a server-side secret (HINT_GRID_SECRET). Without one
 * the lattice is still stable and player-specific, which preserves the
 * anti-averaging and anti-collusion properties; the secret additionally makes
 * the lattice unpredictable to a player who has read this file.
 *
 * Non-finite input is passed through as NaN rather than coerced, so the caller
 * ends up in bandForDistance's "cold" branch instead of somewhere plausible.
 */
export function snapToGrid(
  point: LatLng,
  playerId: string,
  gridSecret: string,
): LatLng {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
    return { lat: NaN, lng: NaN };
  }

  const latStep = HINT_GRID_METERS / METERS_PER_DEG_LAT;
  const offLat = unitHash(`${gridSecret}:${playerId}:lat`) * latStep;

  const latIndex = Math.floor((point.lat + offLat) / latStep);
  const lat = (latIndex + 0.5) * latStep - offLat;

  // Longitude cells are computed from the SNAPPED latitude, so a cell's width
  // is a function of the cell itself. Deriving it from the raw latitude would
  // make the lattice vary continuously with the input, which is the leak this
  // function exists to close.
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const lngStep = latStep / Math.max(Math.abs(cosLat), 1e-6);
  const offLng = unitHash(`${gridSecret}:${playerId}:lng`) * lngStep;

  const lngIndex = Math.floor((point.lng + offLng) / lngStep);
  const lng = (lngIndex + 0.5) * lngStep - offLng;

  return { lat, lng };
}

export interface HintCandidate extends LatLng {
  id: string;
}

export interface ProximityHint {
  band: HintBand;
  /** Number of caches in this hunt the player has not yet found. */
  remaining: number;
}

/**
 * Hint for the nearest *unfound* cache.
 *
 * Callers must pass only caches the player has not yet found — a found cache
 * still influencing the band would keep pointing at a location that no longer
 * pays, which reads as a bug to the player and leaks nothing useful anyway.
 *
 * The snapping happens HERE, not at the route, so a caller cannot forget it and
 * quietly restore the continuous oracle.
 *
 * Returns null when nothing is left to find, so the caller can render a
 * completion state rather than a misleading "cold".
 */
export function proximityHint(
  player: LatLng,
  unfoundCaches: readonly HintCandidate[],
  playerId: string,
  gridSecret: string,
): ProximityHint | null {
  if (unfoundCaches.length === 0) return null;

  const from = snapToGrid(player, playerId, gridSecret);

  let nearest: HintCandidate = unfoundCaches[0];
  let nearestDistance = haversineMeters(from, nearest);

  for (let i = 1; i < unfoundCaches.length; i++) {
    const candidate = unfoundCaches[i];
    const distance = haversineMeters(from, candidate);
    if (distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }

  return {
    band: bandForDistance(nearestDistance, playerId, nearest.id),
    remaining: unfoundCaches.length,
  };
}
