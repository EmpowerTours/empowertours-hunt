// The spawn mechanic — random, VISIBLE, ephemeral native-MON drops.
//
// Written the same way as lib/hunt/validator.ts and for the same reason: the
// decision logic is pure, so a dispute is answered by replaying stored rows
// through these functions rather than by anyone's recollection. No DB, no
// network, no clock — the caller supplies the facts.
//
// WHY SECRECY IS NOT THE CONTROL HERE
//
// A cache is hidden; a spawn is drawn on the player's radar, so its
// coordinates are public the moment it exists. Everything that bounds the risk
// is therefore about MOVEMENT and MONEY, not about concealment:
//
//   * placement is an annulus around `PlayerHunt.lastVerifiedLat/Lng` — the
//     last position the VERIFIER accepted. Never around a self-reported
//     position: a spoofer who could seed placement from their own claim could
//     summon a spawn to any coordinate on earth and then "walk" to it.
//   * `spawnMinRadiusM` means a spawn never lands on top of the player, so
//     collecting one always costs real movement.
//   * the collect runs the same accuracy / clock-skew / cooldown / speed
//     checks a cache claim runs. Identical thresholds, taken from the same
//     Hunt columns.
//   * the amount comes from a server CSPRNG under a published commitment, so
//     it cannot be influenced by the client or chosen after the fact.
//   * short TTL, one collector, atomic caps. Those live in the route, because
//     they are database invariants; this file decides, it does not write.
//
// COMMIT-REVEAL
//
// `seedCommit = sha256(seed)` is written when the spawn appears; `seedReveal`
// is written on collection or expiry. Anyone can then recompute
// sha256(seedReveal) === seedCommit and deriveSpawn(seedReveal, params) ===
// (lat, lng, amount) and see that the drop was fixed before they moved. That
// is the whole point of deriving position AND amount from one seed rather than
// just the amount.
//
// The seed itself is HMAC(secret, spawnId) rather than a stored column: the
// schema has nowhere to keep an unrevealed secret, and a derived seed is
// unguessable without the key while still being recomputable at reveal time.

import { createHash, createHmac, randomBytes } from "node:crypto";
import { haversineMeters, type LatLng } from "@/lib/geo/distance";
import { isWalkable, type WalkableArea } from "@/lib/geo/polygon";
import type { HuntRules } from "@/lib/hunt/validator";

// ---------------------------------------------------------------------------
// Reasons
// ---------------------------------------------------------------------------

/**
 * Why a player may not be granted a spawn right now. Distinct from a collect
 * rejection: nothing here is an accusation, most of it is "not yet".
 */
export const SPAWN_DENY_REASONS = [
  "spawn_disabled",
  "player_not_active",
  "hunt_not_active",
  "hunt_not_started",
  "hunt_ended",
  "no_verified_position",
  "stale_verified_position",
  "spawn_cooldown",
  "spawn_already_active",
  "spawn_bounds_misconfigured",
  // Placement could not find walkable ground within reach — the player is at
  // the edge of the hull, or across the river from all of it. Transient by
  // nature: walking somewhere else fixes it, so this must NOT be treated as
  // terminal by the scan poll.
  "no_walkable_ground",
] as const;
export type SpawnDenyReason = (typeof SPAWN_DENY_REASONS)[number];

/**
 * Why a collect was refused. The first seven mirror lib/hunt/validator.ts
 * exactly — same names, same thresholds, same Hunt columns — because a spawn
 * must not be an easier door into the treasury than a cache is.
 */
export const SPAWN_REJECT_REASONS = [
  "player_not_active",
  "hunt_not_active",
  "hunt_not_started",
  "hunt_ended",
  "gps_accuracy_too_low",
  "clock_skew",
  "cooldown",
  "implausible_speed",
  "spawn_not_found",
  "spawn_expired",
  "spawn_already_collected",
  "out_of_range",
  // Decided by the atomic conditional UPDATEs in the collect route, not here —
  // the same convention lib/hunt/validator.ts uses for its ceiling reasons, so
  // a stored ClaimAttempt.reason is always a value one of these modules knows.
  "hunt_budget_exhausted",
  "player_daily_cap_reached",
  // Postgres refused to serialize the commit and every retry was refused too.
  // Nothing was written and nothing was spent, so the spawn is still there —
  // this is "the server was too busy", not "you cannot have it". Transient by
  // construction, and the ONLY reason in this list that is about the server
  // rather than the player.
  "contended",
] as const;
export type SpawnRejectReason = (typeof SPAWN_REJECT_REASONS)[number];

// ---------------------------------------------------------------------------
// Geodesy
// ---------------------------------------------------------------------------

const EARTH_RADIUS_M = 6_371_000;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/**
 * Destination point given a start, an initial bearing and a distance, on a
 * sphere. The standard direct geodesic formula.
 *
 * Naive degree arithmetic (`lng + meters / 111320`) is wrong everywhere except
 * the equator: at 60° latitude it places the spawn twice as far east as
 * intended, so the annulus a player is asked to walk stops matching the
 * annulus the operator configured.
 */
export function destinationPoint(
  origin: LatLng,
  bearingRad: number,
  distanceM: number,
): LatLng {
  const angular = distanceM / EARTH_RADIUS_M;
  const lat1 = toRad(origin.lat);
  const lng1 = toRad(origin.lng);

  const sinLat2 =
    Math.sin(lat1) * Math.cos(angular) +
    Math.cos(lat1) * Math.sin(angular) * Math.cos(bearingRad);
  const lat2 = Math.asin(sinLat2);
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearingRad) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * sinLat2,
    );

  return {
    lat: toDeg(lat2),
    // Normalise into [-180, 180] so a spawn near the antimeridian is still a
    // valid coordinate rather than lng 187.
    lng: ((toDeg(lng2) + 540) % 360) - 180,
  };
}

// ---------------------------------------------------------------------------
// Seed, commitment, and the draw
// ---------------------------------------------------------------------------

/** 32 bytes of CSPRNG, hex. Never Math.random: it is seeded from the clock and
 *  its output is reconstructible from a handful of observed draws. */
export function generateSeed(): string {
  return randomBytes(32).toString("hex");
}

/**
 * The seed for a spawn, derived rather than stored.
 *
 * HMAC-SHA256(SPAWN_SEED_SECRET, spawnId). Unguessable without the secret,
 * recomputable at reveal time, and it costs no schema column. The caller
 * supplies the secret; this stays pure.
 */
export function deriveSeed(secret: string, spawnId: string): string {
  if (!secret) throw new Error("spawn seed secret is empty");
  if (!spawnId) throw new Error("spawn id is empty");
  return createHmac("sha256", secret).update(spawnId).digest("hex");
}

export function commitSeed(seed: string): string {
  return createHash("sha256").update(seed, "utf8").digest("hex");
}

export function verifySeed(seed: string, seedCommit: string): boolean {
  return commitSeed(seed) === seedCommit;
}

/**
 * Deterministic bytes for one purpose within a seed, extended to `bytes`
 * length by counter-mode hashing. Separate labels so the bearing draw cannot
 * be inferred from the amount draw.
 */
function expand(seed: string, label: string, bytes: number): Buffer {
  const out: Buffer[] = [];
  let counter = 0;
  while (out.reduce((n, b) => n + b.length, 0) < bytes) {
    out.push(
      createHash("sha256")
        .update(`${seed}:${label}:${counter}`, "utf8")
        .digest(),
    );
    counter += 1;
  }
  return Buffer.concat(out).subarray(0, bytes);
}

/** A uniform value in [0, 1) from 8 bytes of the expanded seed. */
function unitFraction(seed: string, label: string): number {
  const b = expand(seed, label, 7); // 56 bits — exactly representable in a double
  let v = 0;
  for (const byte of b) v = v * 256 + byte;
  return v / 2 ** 56;
}

/**
 * Uniform bigint in [min, max] derived from the seed.
 *
 * Rejection sampling, not modulo. `x % range` over-weights the low end of the
 * range by up to one part in 2^bits/range; on a payout that is a systematic,
 * auditable bias in the treasury's favour, which is exactly the kind of thing
 * a commit-reveal scheme is supposed to make impossible to hide.
 */
export function uniformBigInt(
  seed: string,
  label: string,
  min: bigint,
  max: bigint,
): bigint {
  if (max < min) throw new RangeError(`uniformBigInt: max ${max} < min ${min}`);
  const range = max - min + 1n;
  if (range === 1n) return min;

  const bytes = 32;
  const space = 1n << BigInt(bytes * 8);
  const limit = (space / range) * range; // discard the ragged tail

  for (let round = 0; round < 64; round += 1) {
    const draw = BigInt(
      `0x${expand(seed, `${label}:${round}`, bytes).toString("hex")}`,
    );
    if (draw < limit) return min + (draw % range);
  }
  // 64 consecutive rejections is not going to happen (p < 2^-64 for any
  // sensible range), but a loop with no exit is not allowed to exist here.
  throw new Error("uniformBigInt: exhausted rejection sampling rounds");
}

export interface SpawnDrawParams {
  origin: LatLng;
  minRadiusM: number;
  maxRadiusM: number;
  minWei: bigint;
  maxWei: bigint;
}

export interface SpawnDraw {
  lat: number;
  lng: number;
  amountWei: bigint;
  bearingDeg: number;
  distanceM: number;
}

/**
 * The whole draw, as one pure function of the seed. Given a revealed seed and
 * the hunt's parameters, anyone can recompute this and get the same spawn.
 */
export function deriveSpawn(seed: string, params: SpawnDrawParams): SpawnDraw {
  const { origin, minRadiusM, maxRadiusM, minWei, maxWei } = params;
  if (!(Number.isFinite(minRadiusM) && minRadiusM >= 0)) {
    throw new RangeError("minRadiusM must be a non-negative number");
  }
  if (!(Number.isFinite(maxRadiusM) && maxRadiusM >= minRadiusM)) {
    throw new RangeError("maxRadiusM must be >= minRadiusM");
  }
  if (!(minWei >= 0n && maxWei >= minWei)) {
    throw new RangeError("wei bounds must satisfy 0 <= min <= max");
  }

  const bearingRad = unitFraction(seed, "bearing") * 2 * Math.PI;

  // Area-uniform within the annulus. Drawing the radius linearly would cluster
  // spawns near the inner edge, which over time teaches players that walking
  // the minimum distance is enough.
  const u = unitFraction(seed, "radius");
  const distanceM = Math.sqrt(
    minRadiusM ** 2 + u * (maxRadiusM ** 2 - minRadiusM ** 2),
  );

  const point = destinationPoint(origin, bearingRad, distanceM);
  return {
    lat: point.lat,
    lng: point.lng,
    amountWei: uniformBigInt(seed, "amount", minWei, maxWei),
    bearingDeg: toDeg(bearingRad),
    distanceM,
  };
}

/**
 * The seed for one placement attempt.
 *
 * Attempt 0 is the bare seed, so a hunt with no walkable area configured draws
 * exactly what it drew before this function existed, and every existing
 * `deriveSpawn` expectation still holds. Later attempts hash the seed with the
 * attempt index, which keeps the ENTIRE retry sequence recomputable: given the
 * revealed seed, anyone can replay attempts 0..n and confirm both where the
 * accepted spawn landed and that the rejected ones really were unwalkable.
 * Drawing fresh randomness per retry would have silently destroyed that — the
 * seed-reveal promise is that the drop was fixed before the player moved, and
 * an unreproducible retry makes that unverifiable.
 */
function attemptSeed(seed: string, attempt: number): string {
  if (attempt === 0) return seed;
  return createHash("sha256")
    .update(`${seed}:placement:${attempt}`, "utf8")
    .digest("hex");
}

export type SpawnPlacement =
  | { ok: true; draw: SpawnDraw; attempts: number }
  | { ok: false; attempts: number };

/**
 * Draw a spawn that lands on ground a human can walk to.
 *
 * `deriveSpawn` places a point at a uniform bearing and distance on an abstract
 * disc. Left alone it will eventually put a drop in the river, inside a house,
 * or across a highway — and then pay the player for reaching it. This redraws
 * until the point is inside the hunt's surveyed walkable area.
 *
 * DECLINES RATHER THAN LOOPS. After `maxAttempts` the answer is "no spawn this
 * round", never "place it anyway" and never "keep trying". A player whose
 * surroundings are mostly unwalkable — stood at the edge of the hull, or across
 * the river from everything — would otherwise spin this forever. Missing one
 * spawn cycle is a non-event; a loop with no exit in a request path is not.
 *
 * An unsurveyed hunt (no include rings) rejects every attempt and therefore
 * places nothing. That is the intended reading: see `isWalkable`.
 */
export function deriveSpawnInArea(
  seed: string,
  params: SpawnDrawParams,
  area: WalkableArea,
  maxAttempts = 10,
): SpawnPlacement {
  if (!(Number.isInteger(maxAttempts) && maxAttempts >= 1)) {
    throw new RangeError("maxAttempts must be a positive integer");
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const draw = deriveSpawn(attemptSeed(seed, attempt), params);
    if (isWalkable({ lat: draw.lat, lng: draw.lng }, area)) {
      return { ok: true, draw, attempts: attempt + 1 };
    }
  }

  return { ok: false, attempts: maxAttempts };
}

// ---------------------------------------------------------------------------
// Eligibility — may this player be granted a spawn?
// ---------------------------------------------------------------------------

export interface SpawnEligibilityContext {
  serverNow: Date;
  playerActive: boolean;
  huntActive: boolean;
  spawnEnabled: boolean;
  huntStartsAt: Date | null;
  huntEndsAt: Date | null;
  /** Last position the VERIFIER accepted. Placement anchors here or nowhere. */
  lastVerifiedLat: number | null;
  lastVerifiedLng: number | null;
  lastVerifiedAt: Date | null;
  lastSpawnAt: Date | null;
  /** An uncollected, unexpired spawn already on this player's radar. */
  hasActiveSpawn: boolean;
  spawnCooldownSeconds: number;
  spawnMinRadiusM: number;
  spawnMaxRadiusM: number;
  spawnMinWei: bigint;
  spawnMaxWei: bigint;
  /** How old a verified fix may be and still anchor a spawn. */
  maxVerifiedAgeSeconds: number;
}

export interface SpawnEligible {
  ok: true;
  origin: LatLng;
}
export interface SpawnDenied {
  ok: false;
  reason: SpawnDenyReason;
  detail: string;
}
export type SpawnEligibility = SpawnEligible | SpawnDenied;

function deny(reason: SpawnDenyReason, detail: string): SpawnDenied {
  return { ok: false, reason, detail };
}

/**
 * Reject by default. Every branch that is not an explicit accept returns a
 * denial, and every numeric comparison is written as `!(good)` so a NaN or a
 * null cannot slip through as permission.
 */
export function evaluateSpawnEligibility(
  ctx: SpawnEligibilityContext,
): SpawnEligibility {
  if (!ctx.spawnEnabled) return deny("spawn_disabled", "spawns are off");
  if (!ctx.playerActive) {
    return deny("player_not_active", "player is inactive or suspended");
  }
  if (!ctx.huntActive) return deny("hunt_not_active", "hunt is not active");
  if (ctx.huntStartsAt && ctx.serverNow < ctx.huntStartsAt) {
    return deny(
      "hunt_not_started",
      `hunt opens ${ctx.huntStartsAt.toISOString()}`,
    );
  }
  if (ctx.huntEndsAt && ctx.serverNow > ctx.huntEndsAt) {
    return deny("hunt_ended", `hunt closed ${ctx.huntEndsAt.toISOString()}`);
  }

  // Money bounds must be configured before any money can be drawn. A hunt left
  // at the defaults (0/0) produces no spawns rather than free ones.
  if (!(
    ctx.spawnMaxWei > 0n &&
    ctx.spawnMinWei > 0n &&
    ctx.spawnMaxWei >= ctx.spawnMinWei
  )) {
    return deny(
      "spawn_bounds_misconfigured",
      `spawn value bounds [${ctx.spawnMinWei}, ${ctx.spawnMaxWei}] are not a positive range`,
    );
  }
  if (!(
    Number.isFinite(ctx.spawnMinRadiusM) &&
    Number.isFinite(ctx.spawnMaxRadiusM) &&
    ctx.spawnMinRadiusM > 0 &&
    ctx.spawnMaxRadiusM >= ctx.spawnMinRadiusM
  )) {
    return deny(
      "spawn_bounds_misconfigured",
      `spawn radii [${ctx.spawnMinRadiusM}, ${ctx.spawnMaxRadiusM}] are not a positive range`,
    );
  }

  // The anchor. Without a verified fix there is no honest place to put a spawn,
  // and using the player's claimed position instead is the one thing that would
  // make the whole mechanic spoofable.
  if (
    ctx.lastVerifiedLat === null ||
    ctx.lastVerifiedLng === null ||
    ctx.lastVerifiedAt === null ||
    !Number.isFinite(ctx.lastVerifiedLat) ||
    !Number.isFinite(ctx.lastVerifiedLng)
  ) {
    return deny(
      "no_verified_position",
      "no verified position to anchor a spawn to",
    );
  }
  const fixAgeSeconds =
    (ctx.serverNow.getTime() - ctx.lastVerifiedAt.getTime()) / 1000;
  if (!(fixAgeSeconds >= 0 && fixAgeSeconds <= ctx.maxVerifiedAgeSeconds)) {
    return deny(
      "stale_verified_position",
      `last verified fix is ${fixAgeSeconds.toFixed(0)}s old, limit ${ctx.maxVerifiedAgeSeconds}s`,
    );
  }

  if (ctx.hasActiveSpawn) {
    return deny("spawn_already_active", "a spawn is already on the radar");
  }

  if (ctx.lastSpawnAt) {
    const sinceSeconds =
      (ctx.serverNow.getTime() - ctx.lastSpawnAt.getTime()) / 1000;
    if (!(sinceSeconds >= ctx.spawnCooldownSeconds)) {
      return deny(
        "spawn_cooldown",
        `${sinceSeconds.toFixed(0)}s since last spawn, need ${ctx.spawnCooldownSeconds}s`,
      );
    }
  }

  return {
    ok: true,
    origin: { lat: ctx.lastVerifiedLat, lng: ctx.lastVerifiedLng },
  };
}

// ---------------------------------------------------------------------------
// Collection — the same verification a cache claim gets
// ---------------------------------------------------------------------------
//
// `validateClaim` is not reused directly: its shape is cache-specific (it takes
// a list of unfound caches, picks the nearest, and returns a cacheId, and it
// rejects with `no_cache_in_range`). Feeding a spawn through it would mean
// lying to it about what a cache is. What matters is that the CHECKS are the
// same ones, in the same order, against the same Hunt columns — see the
// reason list above, which is deliberately identical for the shared cases.

export interface SpawnAttempt extends LatLng {
  accuracyM: number | null;
  clientTs: Date;
}

export interface SpawnTarget extends LatLng {
  id: string;
  radiusMeters: number;
  expiresAt: Date;
  collectedAt: Date | null;
  /** Whose radar it is on. A spawn is targeted, not first-come. */
  playerId: string;
}

export interface SpawnCollectContext {
  attempt: SpawnAttempt;
  serverNow: Date;
  playerId: string;
  playerActive: boolean;
  huntActive: boolean;
  huntStartsAt: Date | null;
  huntEndsAt: Date | null;
  /** The spawn being collected, or null when the id matched nothing. */
  spawn: SpawnTarget | null;
  /** Most recent accepted position event (find or collect), for the teleport
   *  check. Same role `lastFind` plays in validateClaim. */
  lastAccepted: { lat: number; lng: number; at: Date } | null;
  rules: HuntRules;
}

export interface SpawnCollectAccepted {
  ok: true;
  spawnId: string;
  distanceMeters: number;
  speedKmh: number | null;
}
export interface SpawnCollectRejected {
  ok: false;
  reason: SpawnRejectReason;
  detail: string;
  flagged: boolean;
}
export type SpawnCollectResult = SpawnCollectAccepted | SpawnCollectRejected;

function rejectCollect(
  reason: SpawnRejectReason,
  detail: string,
  flagged = false,
): SpawnCollectRejected {
  return { ok: false, reason, detail, flagged };
}

export function validateSpawnCollect(
  ctx: SpawnCollectContext,
): SpawnCollectResult {
  const { attempt, serverNow, rules } = ctx;

  // --- Eligibility -------------------------------------------------------
  if (!ctx.playerActive) {
    return rejectCollect(
      "player_not_active",
      "player is inactive or suspended",
    );
  }
  if (!ctx.huntActive) {
    return rejectCollect("hunt_not_active", "hunt is not active");
  }
  if (ctx.huntStartsAt && serverNow < ctx.huntStartsAt) {
    return rejectCollect(
      "hunt_not_started",
      `hunt opens ${ctx.huntStartsAt.toISOString()}`,
    );
  }
  if (ctx.huntEndsAt && serverNow > ctx.huntEndsAt) {
    return rejectCollect(
      "hunt_ended",
      `hunt closed ${ctx.huntEndsAt.toISOString()}`,
    );
  }

  // --- The spawn itself --------------------------------------------------
  const spawn = ctx.spawn;
  if (!spawn) {
    return rejectCollect("spawn_not_found", "no such spawn for this player");
  }
  if (spawn.playerId !== ctx.playerId) {
    // Same reason string as a missing spawn: a player learns nothing about
    // another player's radar from the shape of the refusal.
    return rejectCollect(
      "spawn_not_found",
      "spawn belongs to another player",
      true,
    );
  }
  if (spawn.collectedAt !== null) {
    return rejectCollect("spawn_already_collected", "spawn already collected");
  }
  if (!(serverNow < spawn.expiresAt)) {
    return rejectCollect(
      "spawn_expired",
      `spawn expired ${spawn.expiresAt.toISOString()}`,
    );
  }

  // --- Signal quality ----------------------------------------------------
  // A null accuracy is unusable, not perfect. "Unknown" must never be the
  // permissive branch on a path that spends money.
  if (attempt.accuracyM === null) {
    return rejectCollect(
      "gps_accuracy_too_low",
      "device reported no GPS accuracy",
    );
  }
  if (!(attempt.accuracyM <= rules.maxAccuracyM)) {
    return rejectCollect(
      "gps_accuracy_too_low",
      `accuracy ${attempt.accuracyM}m exceeds ${rules.maxAccuracyM}m`,
    );
  }

  const skewSeconds = Math.abs(
    (attempt.clientTs.getTime() - serverNow.getTime()) / 1000,
  );
  if (!(skewSeconds <= rules.maxClockSkewSeconds)) {
    return rejectCollect(
      "clock_skew",
      `device clock off by ${skewSeconds.toFixed(0)}s`,
      true,
    );
  }

  // --- Movement plausibility ---------------------------------------------
  // Measured against the SERVER clock, for the same reason validateClaim does:
  // reading elapsed time from the device's clock lets a player widen the window
  // and make a teleport look like a walk.
  let speedKmh: number | null = null;
  if (ctx.lastAccepted) {
    const elapsedSeconds =
      (serverNow.getTime() - ctx.lastAccepted.at.getTime()) / 1000;

    if (!(elapsedSeconds >= rules.cooldownSeconds)) {
      return rejectCollect(
        "cooldown",
        `${elapsedSeconds.toFixed(0)}s since last accepted position, need ${rules.cooldownSeconds}s`,
      );
    }
    if (elapsedSeconds > 0) {
      const meters = haversineMeters(ctx.lastAccepted, attempt);
      speedKmh = (meters / elapsedSeconds) * 3.6;
      if (!(speedKmh <= rules.maxSpeedKmh)) {
        return rejectCollect(
          "implausible_speed",
          `${speedKmh.toFixed(1)} km/h since last accepted position exceeds ${rules.maxSpeedKmh}`,
          true,
        );
      }
    }
  }

  // --- Geofence ----------------------------------------------------------
  const distanceMeters = haversineMeters(attempt, spawn);
  if (!(distanceMeters <= spawn.radiusMeters)) {
    // Safe to state the distance: the spawn's coordinates are public anyway.
    return rejectCollect(
      "out_of_range",
      `${distanceMeters.toFixed(1)}m from the spawn, radius ${spawn.radiusMeters}m`,
    );
  }

  return { ok: true, spawnId: spawn.id, distanceMeters, speedKmh };
}
