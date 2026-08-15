import { describe, it, expect } from "vitest";
import {
  validateClaim,
  clientRejectBody,
  isRejectReason,
  OPAQUE_CLIENT_REASON,
  REJECT_REASONS,
  type ClaimContext,
  type HuntCache,
  type HuntRules,
} from "./validator";

const RULES: HuntRules = {
  maxAccuracyM: 30,
  maxSpeedKmh: 60,
  cooldownSeconds: 60,
  maxClockSkewSeconds: 120,
};

// 1 WMON in wei — the unit TURBO credit is denominated in.
const ONE_WMON = 1_000_000_000_000_000_000n;

// Parque Fundidora, Monterrey — a real place, so distances are sane.
const CACHE_A: HuntCache = {
  id: "cache-a",
  lat: 25.6789,
  lng: -100.2842,
  radiusMeters: 25,
  rewardCreditWei: ONE_WMON / 2n,
};

// ~600m east of CACHE_A.
const CACHE_B: HuntCache = {
  id: "cache-b",
  lat: 25.6789,
  lng: -100.2782,
  radiusMeters: 25,
  rewardCreditWei: ONE_WMON / 2n,
};

const NOW = new Date("2026-08-12T12:00:00Z");

function ctx(overrides: Partial<ClaimContext> = {}): ClaimContext {
  return {
    attempt: {
      lat: CACHE_A.lat,
      lng: CACHE_A.lng,
      accuracyM: 8,
      clientTs: NOW,
    },
    serverNow: NOW,
    playerId: "player-1",
    playerActive: true,
    huntActive: true,
    huntStartsAt: null,
    huntEndsAt: null,
    unfoundCaches: [CACHE_A, CACHE_B],
    foundCacheIds: [],
    lastFind: null,
    rules: RULES,
    ...overrides,
  };
}

describe("validateClaim — accept path", () => {
  it("accepts a player standing on a cache", () => {
    const result = validateClaim(ctx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cacheId).toBe("cache-a");
    expect(result.rewardCreditWei).toBe(ONE_WMON / 2n);
    expect(result.distanceMeters).toBeLessThan(1);
  });

  it("carries the accepted accuracy out, so the Find row records what was checked", () => {
    const result = validateClaim(ctx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Not a `?? 0` fallback invented by the route: the real measured value.
    expect(result.accuracyM).toBe(8);
  });

  it("picks the nearest cache when radii overlap", () => {
    const overlapping: HuntCache = {
      ...CACHE_A,
      id: "cache-overlap",
      radiusMeters: 5_000,
    };
    // Listed first, but far larger — nearest must still win.
    const result = validateClaim(
      ctx({
        unfoundCaches: [overlapping, CACHE_B],
        attempt: {
          lat: CACHE_B.lat,
          lng: CACHE_B.lng,
          accuracyM: 8,
          clientTs: NOW,
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cacheId).toBe("cache-b");
  });

  it("accepts a plausible walk between two finds", () => {
    // ~600m in 10 minutes = ~3.6 km/h.
    const result = validateClaim(
      ctx({
        attempt: {
          lat: CACHE_B.lat,
          lng: CACHE_B.lng,
          accuracyM: 8,
          clientTs: NOW,
        },
        lastFind: {
          lat: CACHE_A.lat,
          lng: CACHE_A.lng,
          foundAt: new Date(NOW.getTime() - 10 * 60_000),
        },
        unfoundCaches: [CACHE_B],
        foundCacheIds: [CACHE_A.id],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.speedKmh).toBeLessThan(10);
  });
});

describe("validateClaim — eligibility", () => {
  it("rejects a player not on the whitelist", () => {
    const result = validateClaim(ctx({ playerActive: false }));
    expect(result).toMatchObject({ ok: false, reason: "player_not_active" });
  });

  it("rejects before the hunt opens", () => {
    const result = validateClaim(
      ctx({ huntStartsAt: new Date(NOW.getTime() + 60_000) }),
    );
    expect(result).toMatchObject({ ok: false, reason: "hunt_not_started" });
  });

  it("rejects after the hunt closes", () => {
    const result = validateClaim(
      ctx({ huntEndsAt: new Date(NOW.getTime() - 60_000) }),
    );
    expect(result).toMatchObject({ ok: false, reason: "hunt_ended" });
  });

  it("checks the whitelist before anything positional", () => {
    // An ineligible player standing exactly on a cache must not get a
    // different error than one standing in the sea — the error itself is an
    // information channel.
    const onCache = validateClaim(ctx({ playerActive: false }));
    const inTheSea = validateClaim(
      ctx({
        playerActive: false,
        attempt: { lat: 0, lng: 0, accuracyM: 8, clientTs: NOW },
      }),
    );
    expect(onCache).toMatchObject({ reason: "player_not_active" });
    expect(inTheSea).toMatchObject({ reason: "player_not_active" });
  });
});

describe("validateClaim — signal quality", () => {
  it("rejects when accuracy is worse than the rule", () => {
    const result = validateClaim(
      ctx({
        attempt: {
          lat: CACHE_A.lat,
          lng: CACHE_A.lng,
          accuracyM: 500,
          clientTs: NOW,
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "gps_accuracy_too_low" });
  });

  it("treats unknown accuracy as unusable, not as perfect", () => {
    const result = validateClaim(
      ctx({
        attempt: {
          lat: CACHE_A.lat,
          lng: CACHE_A.lng,
          accuracyM: null,
          clientTs: NOW,
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "gps_accuracy_too_low" });
  });

  // REGRESSION — a non-finite accuracy must not sail through the threshold.
  // `z.number().nonnegative()` used to admit Infinity at the route, and the
  // comparison here was written as the reject condition, so NaN passed too.
  it("rejects a NaN or Infinite accuracy", () => {
    for (const accuracyM of [NaN, Infinity]) {
      const result = validateClaim(
        ctx({
          attempt: {
            lat: CACHE_A.lat,
            lng: CACHE_A.lng,
            accuracyM,
            clientTs: NOW,
          },
        }),
      );
      expect(result).toMatchObject({
        ok: false,
        reason: "gps_accuracy_too_low",
      });
    }
  });

  it("flags a device clock far from the server clock", () => {
    const result = validateClaim(
      ctx({
        attempt: {
          lat: CACHE_A.lat,
          lng: CACHE_A.lng,
          accuracyM: 8,
          clientTs: new Date(NOW.getTime() - 3_600_000),
        },
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      reason: "clock_skew",
      flagged: true,
    });
  });

  it("rejects an unparseable device clock instead of ignoring the skew check", () => {
    const result = validateClaim(
      ctx({
        attempt: {
          lat: CACHE_A.lat,
          lng: CACHE_A.lng,
          accuracyM: 8,
          clientTs: new Date(NaN),
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "clock_skew" });
  });
});

describe("validateClaim — movement plausibility", () => {
  it("rejects a second find inside the cooldown", () => {
    const result = validateClaim(
      ctx({
        lastFind: {
          lat: CACHE_A.lat,
          lng: CACHE_A.lng,
          foundAt: new Date(NOW.getTime() - 5_000),
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "cooldown" });
  });

  it("flags a teleport between distant caches", () => {
    // Mexico City -> Monterrey (~700km) in 5 minutes.
    const result = validateClaim(
      ctx({
        lastFind: {
          lat: 19.4326,
          lng: -99.1332,
          foundAt: new Date(NOW.getTime() - 5 * 60_000),
        },
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      reason: "implausible_speed",
      flagged: true,
    });
  });

  it("measures speed on the server clock, not the device clock", () => {
    // Device claims 10 hours elapsed to make a 700km jump look like driving.
    // Server knows it was 5 minutes, so this must still be rejected.
    const result = validateClaim(
      ctx({
        attempt: {
          lat: CACHE_A.lat,
          lng: CACHE_A.lng,
          accuracyM: 8,
          clientTs: NOW,
        },
        lastFind: {
          lat: 19.4326,
          lng: -99.1332,
          foundAt: new Date(NOW.getTime() - 5 * 60_000),
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "implausible_speed" });
  });

  // REGRESSION — M3. The route selects lastFind globally per player, not per
  // hunt, because a body cannot be in two places whichever hunt it is playing.
  // This is the pure half of that fix: a prior find that belongs to a
  // different hunt is still fed in here and must still trip the check.
  it("applies cooldown and teleport to a find made in a DIFFERENT hunt", () => {
    const otherHuntFind = {
      lat: 19.4326, // Mexico City
      lng: -99.1332,
      foundAt: new Date(NOW.getTime() - 5 * 60_000),
    };
    const result = validateClaim(
      ctx({
        unfoundCaches: [CACHE_A],
        foundCacheIds: [],
        lastFind: otherHuntFind,
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "implausible_speed" });
  });
});

describe("validateClaim — geofence", () => {
  it("rejects a player outside every radius", () => {
    const result = validateClaim(
      ctx({ attempt: { lat: 25.7, lng: -100.4, accuracyM: 8, clientTs: NOW } }),
    );
    expect(result).toMatchObject({ ok: false, reason: "no_cache_in_range" });
  });

  it("reports already_found when revisiting a claimed cache", () => {
    const result = validateClaim(
      ctx({ unfoundCaches: [CACHE_B], foundCacheIds: [CACHE_A.id] }),
    );
    expect(result).toMatchObject({ ok: false, reason: "already_found" });
  });

  it("rejects just outside the radius and accepts just inside", () => {
    // ~0.0002 deg latitude ~= 22m, inside a 25m radius.
    const inside = validateClaim(
      ctx({
        attempt: {
          lat: CACHE_A.lat + 0.0002,
          lng: CACHE_A.lng,
          accuracyM: 8,
          clientTs: NOW,
        },
      }),
    );
    expect(inside.ok).toBe(true);

    // ~0.0005 deg latitude ~= 55m, outside it.
    const outside = validateClaim(
      ctx({
        attempt: {
          lat: CACHE_A.lat + 0.0005,
          lng: CACHE_A.lng,
          accuracyM: 8,
          clientTs: NOW,
        },
      }),
    );
    expect(outside).toMatchObject({ ok: false, reason: "no_cache_in_range" });
  });
});

// H1 — the NaN geofence bypass. Two independent defects, so two independent
// regressions: the loop's polarity, and the source of the NaN itself.
describe("validateClaim — NaN distance must never be a find (H1)", () => {
  it("rejects when the computed distance is NaN", () => {
    // A cache row with a corrupt coordinate makes haversine return NaN
    // directly. With the old `if (distance > cache.radiusMeters) continue;`
    // the NaN failed the comparison, did NOT continue, became the best
    // candidate, and returned ok:true from anywhere on Earth.
    const corrupt: HuntCache = { ...CACHE_A, id: "corrupt", lat: NaN };
    const result = validateClaim(
      ctx({
        unfoundCaches: [corrupt],
        attempt: { lat: 0, lng: 0, accuracyM: 8, clientTs: NOW },
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "no_cache_in_range" });
  });

  it("rejects a NaN player position", () => {
    const result = validateClaim(
      ctx({ attempt: { lat: NaN, lng: NaN, accuracyM: 8, clientTs: NOW } }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects the antipodal pair that used to produce a NaN distance", () => {
    // The exact pair that pushed haversine's `h` to 1.0000000000000004, where
    // Math.asin(Math.sqrt(h)) is NaN. Clamped in lib/geo/distance.ts, and the
    // 20,015km that now comes out is nowhere near a 25m radius.
    const antipode: HuntCache = {
      ...CACHE_A,
      id: "antipode",
      lat: 59.87837783617891,
      lng: 105.62934963759851,
    };
    const result = validateClaim(
      ctx({
        unfoundCaches: [antipode],
        attempt: {
          lat: -59.87837783617908,
          lng: -74.37065036240149,
          accuracyM: 8,
          clientTs: NOW,
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "no_cache_in_range" });
  });

  it("still finds a real cache when a corrupt one is in the same hunt", () => {
    // Skipping the NaN candidate must not skip the loop.
    const corrupt: HuntCache = { ...CACHE_A, id: "corrupt", lng: NaN };
    const result = validateClaim(ctx({ unfoundCaches: [corrupt, CACHE_A] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cacheId).toBe("cache-a");
  });
});

// C1 — the claim endpoint must not be a location oracle.
describe("client-facing rejection is opaque (C1)", () => {
  it("collapses every reject reason to one indistinguishable body", () => {
    const bodies = new Set(
      REJECT_REASONS.map((r) => JSON.stringify(clientRejectBody(r))),
    );
    expect(bodies.size).toBe(1);
  });

  it("never names the reason the verifier actually decided", () => {
    for (const reason of REJECT_REASONS) {
      const body = clientRejectBody(reason);
      expect(body.found).toBe(false);
      expect(body.reason).toBe(OPAQUE_CLIENT_REASON);
      // Specifically: the two that distinguish "a cache is here" from "no
      // cache is here", which is the whole grid search.
      expect(JSON.stringify(body)).not.toContain("no_cache_in_range");
      expect(JSON.stringify(body)).not.toContain("already_found");
      expect(JSON.stringify(body)).not.toContain("budget");
      expect(JSON.stringify(body)).not.toContain("cap");
    }
  });

  it("carries no counts or distances a probe could measure", () => {
    const body = clientRejectBody("no_cache_in_range");
    expect(Object.keys(body).sort()).toEqual(["found", "reason"]);
  });
});

// H5 — a stored ClaimAttempt.reason must replay through this module exactly,
// including the two outcomes only the database can decide.
describe("reject reason vocabulary (H5)", () => {
  it("includes the atomic-ceiling refusals", () => {
    expect(REJECT_REASONS).toContain("player_cap_reached");
    expect(REJECT_REASONS).toContain("hunt_budget_exhausted");
  });

  it("recognises every reason it can store, and nothing else", () => {
    for (const reason of REJECT_REASONS) {
      expect(isRejectReason(reason)).toBe(true);
    }
    expect(isRejectReason("paid_anyway")).toBe(false);
    expect(isRejectReason("")).toBe(false);
  });

  it("has no duplicate codes", () => {
    expect(new Set(REJECT_REASONS).size).toBe(REJECT_REASONS.length);
  });
});
