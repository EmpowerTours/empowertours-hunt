// ---------------------------------------------------------------------------
// What a Sembrador may plant, and where.
//
// A Sembrador seeds and funds caches in their own city. Opening hunt creation
// to anyone is what makes this a platform rather than one town's game — and it
// is also the moment strangers start deciding where other strangers walk, and
// where a treasury pays out.
//
// Pure: no database, no clock, no network. The route enforces the counts with
// atomic SQL for the same reason the credit ceiling is enforced in the
// database — a predicate evaluated in application code is a read-then-write,
// and K concurrent creates all pass it. These functions are the shared
// definition and the unit-test surface, NOT the enforcement.
// ---------------------------------------------------------------------------

import { haversineMeters, type LatLng } from "@/lib/geo/distance";

/** How many hunts one wallet may have open at once. */
export const MAX_HUNTS_PER_PLAYER = 3;

/** How many caches one hunt may hold. */
export const MAX_CACHES_PER_HUNT = 50;

/**
 * Minimum distance between two caches in the same hunt.
 *
 * The anti-abuse invariant that matters most here. Without it a Sembrador
 * stacks fifty caches on one bench and a single standing player collects the
 * entire hunt without walking anywhere — which converts a walking game into a
 * faucet, and converts a funded budget into one person's withdrawal.
 *
 * 60m is comfortably outside the 25m default claim radius plus GPS error, so
 * two legitimate caches never overlap, and it is short enough that a plaza can
 * still hold several.
 */
export const MIN_CACHE_SEPARATION_M = 60;

/** Bounds on a single cache's claim radius. */
export const MIN_CACHE_RADIUS_M = 10;
export const MAX_CACHE_RADIUS_M = 100;

export type PlantRefusal =
  | "too_many_hunts"
  | "hunt_full"
  | "bad_coordinates"
  | "null_island"
  | "radius_out_of_range"
  | "too_close_to_existing";

export type PlantCheck = { ok: true } | { ok: false; reason: PlantRefusal };

const OK: PlantCheck = { ok: true };

/** May this player open another hunt? */
export function mayCreateHunt(openHunts: number): PlantCheck {
  if (openHunts >= MAX_HUNTS_PER_PLAYER) {
    return { ok: false, reason: "too_many_hunts" };
  }
  return OK;
}

/**
 * Are these coordinates a real place somebody could stand?
 *
 * Rejects (0, 0) specifically. It is in the Gulf of Guinea and essentially
 * every occurrence of it in a coordinate field is a default value that was
 * never filled in — accepting it plants a cache in the ocean and tells the
 * Sembrador nothing went wrong.
 */
export function validCoordinates(lat: number, lng: number): PlantCheck {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, reason: "bad_coordinates" };
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { ok: false, reason: "bad_coordinates" };
  }
  if (lat === 0 && lng === 0) {
    return { ok: false, reason: "null_island" };
  }
  return OK;
}

export function validRadius(radiusMeters: number): PlantCheck {
  if (!Number.isInteger(radiusMeters)) {
    return { ok: false, reason: "radius_out_of_range" };
  }
  if (radiusMeters < MIN_CACHE_RADIUS_M || radiusMeters > MAX_CACHE_RADIUS_M) {
    return { ok: false, reason: "radius_out_of_range" };
  }
  return OK;
}

/**
 * Everything about one proposed cache, against the hunt's existing ones.
 *
 * `existing` carries only coordinates — this function has no business seeing
 * labels or rewards, and keeping the input narrow means a caller cannot
 * accidentally pass a row that still holds secrets.
 */
export function mayPlantCache(args: {
  lat: number;
  lng: number;
  radiusMeters: number;
  existing: readonly LatLng[];
}): PlantCheck {
  const coords = validCoordinates(args.lat, args.lng);
  if (!coords.ok) return coords;

  const radius = validRadius(args.radiusMeters);
  if (!radius.ok) return radius;

  if (args.existing.length >= MAX_CACHES_PER_HUNT) {
    return { ok: false, reason: "hunt_full" };
  }

  const here: LatLng = { lat: args.lat, lng: args.lng };
  for (const other of args.existing) {
    if (haversineMeters(here, other) < MIN_CACHE_SEPARATION_M) {
      return { ok: false, reason: "too_close_to_existing" };
    }
  }

  return OK;
}

/** What to tell the Sembrador, in the language they are planting in. */
export function explainPlantRefusal(
  reason: PlantRefusal,
  lang: "es" | "en",
): string {
  const ES: Record<PlantRefusal, string> = {
    too_many_hunts: `Ya tienes ${MAX_HUNTS_PER_PLAYER} búsquedas abiertas. Cierra una para crear otra.`,
    hunt_full: `Una búsqueda puede tener hasta ${MAX_CACHES_PER_HUNT} caches.`,
    bad_coordinates: "Esas coordenadas no son válidas.",
    null_island:
      "Esas coordenadas apuntan al océano. ¿Se quedó el campo vacío?",
    radius_out_of_range: `El radio debe estar entre ${MIN_CACHE_RADIUS_M} y ${MAX_CACHE_RADIUS_M} metros.`,
    too_close_to_existing: `Hay otro cache a menos de ${MIN_CACHE_SEPARATION_M} metros. Sepáralos para que haya que caminar.`,
  };
  const EN: Record<PlantRefusal, string> = {
    too_many_hunts: `You already have ${MAX_HUNTS_PER_PLAYER} hunts open. Close one to start another.`,
    hunt_full: `A hunt can hold up to ${MAX_CACHES_PER_HUNT} caches.`,
    bad_coordinates: "Those coordinates aren't valid.",
    null_island:
      "Those coordinates point at the ocean. Was the field left empty?",
    radius_out_of_range: `Radius must be between ${MIN_CACHE_RADIUS_M} and ${MAX_CACHE_RADIUS_M} metres.`,
    too_close_to_existing: `Another cache is within ${MIN_CACHE_SEPARATION_M} metres. Spread them out so there's a walk.`,
  };
  return lang === "es" ? ES[reason] : EN[reason];
}
