// The verifier. Everything else in this repo is UI around this function.
//
// A cache find issues TURBO credit (WMON-wei, non-withdrawable), so this is the
// boundary between "a player walked somewhere" and "the treasury gives away
// margin". It is deliberately a pure function: no DB, no network, no clock. The
// route supplies the facts, this decides. That makes every rejection
// reproducible from a stored ClaimAttempt row, which is what makes the ledger
// auditable after the fact — replay must be EXACT, so every reason code the
// system can ever store lives in REJECT_REASONS below, including the two the
// route decides (the atomic ceilings, which are database invariants and cannot
// be evaluated by a pure function).
//
// It is written to REJECT BY DEFAULT. Every path that is not an explicit
// accept returns a rejection with a reason code.

import { haversineMeters, type LatLng } from "@/lib/geo/distance";

export const REJECT_REASONS = [
  "player_not_active",
  "hunt_not_active",
  "hunt_not_started",
  "hunt_ended",
  "gps_accuracy_too_low",
  "clock_skew",
  "cooldown",
  "implausible_speed",
  "no_cache_in_range",
  "already_found",
  // Decided by the atomic conditional UPDATEs in the claim route, not here.
  // They are listed so a stored ClaimAttempt.reason is always a RejectReason
  // and a dispute replay never meets a string this module does not know.
  "player_cap_reached",
  "hunt_budget_exhausted",
] as const;

export type RejectReason = (typeof REJECT_REASONS)[number];

export function isRejectReason(value: string): value is RejectReason {
  return (REJECT_REASONS as readonly string[]).includes(value);
}

/**
 * The ONLY rejection string a client is ever told.
 *
 * WHY: the claim endpoint is otherwise a location oracle that pays for itself.
 * Distinguishable outcomes ("no_cache_in_range" vs "already_found" vs a budget
 * reason) let an attacker grid-search coordinates at ~35m spacing and map every
 * cache in the hunt — and the probe IS the payout, so the search is free and
 * the finds are real. Collapsing every non-accept into one opaque string makes
 * a probe worth exactly zero bits. The precise reason still goes to
 * ClaimAttempt for the audit; the player never sees it.
 */
export const OPAQUE_CLIENT_REASON = "no_find_here";

export interface ClientRejectBody {
  found: false;
  reason: typeof OPAQUE_CLIENT_REASON;
}

/**
 * Build the client-facing body for ANY rejection.
 *
 * `auditReason` is taken and deliberately discarded. It is a parameter rather
 * than absent so that the collapse is visible at every call site: whoever adds
 * a new reject reason has to hand it to this function, and this function is
 * where it stops.
 */
export function clientRejectBody(auditReason: RejectReason): ClientRejectBody {
  void auditReason;
  return { found: false, reason: OPAQUE_CLIENT_REASON };
}

export interface HuntCache extends LatLng {
  id: string;
  radiusMeters: number;
  /**
   * TURBO credit reward in WMON-wei. `bigint`, never `number` — an 18-decimal
   * value exceeds Number.MAX_SAFE_INTEGER and would silently lose precision,
   * and a rounding error here is a rounding error in the ledger. The DB column
   * is `Decimal(78, 0)`; the route converts with lib/wei.ts, never `Number()`.
   */
  rewardCreditWei: bigint;
}

export interface ClaimAttempt extends LatLng {
  /** Device-reported horizontal accuracy in meters. */
  accuracyM: number | null;
  /** Device clock at capture. */
  clientTs: Date;
}

export interface PriorFind {
  lat: number;
  lng: number;
  foundAt: Date;
}

export interface HuntRules {
  /** Reject when the device cannot place itself this precisely. */
  maxAccuracyM: number;
  /** Ground speed above this between consecutive finds is not a human. */
  maxSpeedKmh: number;
  /** Minimum seconds between two accepted finds. */
  cooldownSeconds: number;
  /** Tolerated disagreement between device clock and server clock. */
  maxClockSkewSeconds: number;
}

export interface ClaimContext {
  attempt: ClaimAttempt;
  /** Server-authoritative receipt time. Never trust clientTs alone. */
  serverNow: Date;
  playerId: string;
  playerActive: boolean;
  huntActive: boolean;
  huntStartsAt: Date | null;
  huntEndsAt: Date | null;
  /** Caches in THIS hunt the player has NOT yet found. */
  unfoundCaches: readonly HuntCache[];
  /** Cache ids in THIS hunt the player HAS found — used to distinguish re-claims. */
  foundCacheIds: readonly string[];
  /**
   * The player's most recent accepted find ACROSS EVERY HUNT.
   *
   * Not per-hunt. Cooldown and teleport are properties of a human body, not of
   * a hunt: scoped per-hunt, a player enrolled in two hunts alternates between
   * them and never trips either check, which is a full bypass of the movement
   * plausibility layer. `Find` carries `@@index([playerId, foundAt])`
   * specifically so this lookup is a global one.
   */
  lastFind: PriorFind | null;
  rules: HuntRules;
}

export interface ClaimAccepted {
  ok: true;
  cacheId: string;
  distanceMeters: number;
  /**
   * The accuracy the verifier actually accepted. Carried out so the Find row
   * records the value that was checked, and so the route never has to
   * re-narrow `accuracyM: number | null` with a `?? 0` fallback — that fallback
   * used to write a fictitious "0m accuracy" into the audit trail on a path
   * that is unreachable anyway, because a null accuracy is rejected above.
   */
  accuracyM: number;
  /** TURBO credit reward in WMON-wei, carried through untouched from the cache. */
  rewardCreditWei: bigint;
  /** Ground speed since the previous find, when one exists. */
  speedKmh: number | null;
}

export interface ClaimRejected {
  ok: false;
  reason: RejectReason;
  /** Human-readable detail for the audit log. Never rendered to the player verbatim. */
  detail: string;
  /** Populated when the rejection is worth a human look rather than a retry. */
  flagged: boolean;
}

export type ClaimResult = ClaimAccepted | ClaimRejected;

function reject(
  reason: RejectReason,
  detail: string,
  flagged = false,
): ClaimRejected {
  return { ok: false, reason, detail, flagged };
}

export function validateClaim(ctx: ClaimContext): ClaimResult {
  const { attempt, serverNow, rules } = ctx;

  // --- Eligibility -------------------------------------------------------
  // Whitelist first: an inactive player should not learn anything about cache
  // positions from the shape of the error they get back.
  if (!ctx.playerActive) {
    return reject("player_not_active", "player not on the hunt whitelist");
  }
  if (!ctx.huntActive) {
    return reject("hunt_not_active", "hunt is not active");
  }
  if (ctx.huntStartsAt && serverNow < ctx.huntStartsAt) {
    return reject(
      "hunt_not_started",
      `hunt opens ${ctx.huntStartsAt.toISOString()}`,
    );
  }
  if (ctx.huntEndsAt && serverNow > ctx.huntEndsAt) {
    return reject("hunt_ended", `hunt closed ${ctx.huntEndsAt.toISOString()}`);
  }

  // --- Signal quality ----------------------------------------------------
  // A null accuracy means the device declined to say. Treat that as unusable
  // rather than perfect: "unknown" must never be the permissive branch when
  // the accept path spends money.
  if (attempt.accuracyM === null) {
    return reject("gps_accuracy_too_low", "device reported no GPS accuracy");
  }
  // Stated as "not good enough" rather than "too big" so a NaN accuracy — which
  // fails `> maxAccuracyM` just as it fails everything else — is rejected
  // instead of waved through. The route's schema rejects NaN too; both, because
  // this function is also replayed against stored rows.
  if (!(attempt.accuracyM <= rules.maxAccuracyM)) {
    return reject(
      "gps_accuracy_too_low",
      `accuracy ${attempt.accuracyM.toFixed(1)}m exceeds ${rules.maxAccuracyM}m`,
    );
  }

  // A device clock far from the server's is either broken or being steered to
  // defeat the speed check below, which reads timestamps to measure elapsed
  // time. Flag rather than silently accept.
  const skewSeconds = Math.abs(
    (attempt.clientTs.getTime() - serverNow.getTime()) / 1000,
  );
  if (!(skewSeconds <= rules.maxClockSkewSeconds)) {
    return reject(
      "clock_skew",
      `device clock off by ${skewSeconds.toFixed(0)}s`,
      true,
    );
  }

  // --- Movement plausibility --------------------------------------------
  // Measured against the SERVER clock. Using clientTs here would let a player
  // widen the elapsed window by lying about their own clock, which is exactly
  // what makes a teleport look like a walk.
  //
  // `lastFind` is the player's last find anywhere, not in this hunt — see the
  // note on ClaimContext.lastFind.
  let speedKmh: number | null = null;
  if (ctx.lastFind) {
    const elapsedSeconds =
      (serverNow.getTime() - ctx.lastFind.foundAt.getTime()) / 1000;

    if (!(elapsedSeconds >= rules.cooldownSeconds)) {
      return reject(
        "cooldown",
        `${elapsedSeconds.toFixed(0)}s since last find, need ${rules.cooldownSeconds}s`,
      );
    }

    if (elapsedSeconds > 0) {
      const meters = haversineMeters(ctx.lastFind, attempt);
      speedKmh = (meters / elapsedSeconds) * 3.6;
      if (!(speedKmh <= rules.maxSpeedKmh)) {
        return reject(
          "implausible_speed",
          `${speedKmh.toFixed(1)} km/h since last find exceeds ${rules.maxSpeedKmh}`,
          true,
        );
      }
    }
  }

  // --- Geofence ----------------------------------------------------------
  // Nearest match wins, so overlapping caches resolve deterministically
  // instead of by array order.
  //
  // POLARITY IS LOAD-BEARING. This loop used to read
  //   `if (distance > cache.radiusMeters) continue;`
  // which is the reject condition, and `NaN > 25` is false — so a NaN distance
  // did NOT continue, fell through as a candidate, and returned ok:true from
  // anywhere on Earth. NaN was reachable: haversine's `Math.asin(Math.sqrt(h))`
  // produced one for near-antipodal points before the clamp landed in
  // lib/geo/distance.ts. Both ends are fixed, and this end states the ACCEPT
  // condition and negates it, with an explicit finiteness guard on top.
  let best: { cache: HuntCache; distance: number } | null = null;
  for (const cache of ctx.unfoundCaches) {
    const distance = haversineMeters(attempt, cache);
    if (!Number.isFinite(distance)) continue;
    if (!(distance <= cache.radiusMeters)) continue;
    if (!best || distance < best.distance) best = { cache, distance };
  }

  if (!best) {
    // These two reasons are for the AUDIT ROW only. The route collapses every
    // rejection to OPAQUE_CLIENT_REASON before it reaches the player —
    // "already_found" vs "no_cache_in_range" is precisely the bit an attacker
    // grid-searching for caches wants.
    const alreadyFound = ctx.foundCacheIds.length > 0;
    return reject(
      alreadyFound ? "already_found" : "no_cache_in_range",
      alreadyFound
        ? "no unfound cache in range; player may be revisiting a found one"
        : "no cache in range",
    );
  }

  return {
    ok: true,
    cacheId: best.cache.id,
    distanceMeters: best.distance,
    accuracyM: attempt.accuracyM,
    rewardCreditWei: best.cache.rewardCreditWei,
    speedKmh,
  };
}
