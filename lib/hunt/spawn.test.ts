import { describe, it, expect } from "vitest";
import { haversineMeters } from "@/lib/geo/distance";
import {
  destinationPoint,
  generateSeed,
  deriveSeed,
  commitSeed,
  verifySeed,
  uniformBigInt,
  deriveSpawn,
  deriveSpawnInArea,
  evaluateSpawnEligibility,
  validateSpawnCollect,
  type SpawnEligibilityContext,
  type SpawnCollectContext,
} from "@/lib/hunt/spawn";
import { isWalkable, type Ring } from "@/lib/geo/polygon";

const ORIGIN = { lat: 19.4326, lng: -99.1332 }; // Mexico City
const NOW = new Date("2026-08-12T12:00:00.000Z");

describe("destinationPoint", () => {
  it("lands exactly the requested distance away, on any bearing", () => {
    for (const bearingDeg of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const p = destinationPoint(ORIGIN, (bearingDeg * Math.PI) / 180, 500);
      expect(haversineMeters(ORIGIN, p)).toBeCloseTo(500, 1);
    }
  });

  it("is correct at high latitude, where naive degree arithmetic is not", () => {
    // The bug this replaces: `lng + meters / 111320` ignores the cos(lat)
    // convergence of meridians. At 60°N that places a spawn twice as far east
    // as intended, so the annulus the player is asked to walk stops matching
    // the one the operator configured.
    const high = { lat: 60, lng: 10 };
    const east = destinationPoint(high, Math.PI / 2, 1000);
    expect(haversineMeters(high, east)).toBeCloseTo(1000, 1);

    const naive = { lat: high.lat, lng: high.lng + 1000 / 111_320 };
    expect(haversineMeters(high, naive)).toBeLessThan(600);
  });

  it("normalises across the antimeridian instead of emitting lng 180.01", () => {
    const p = destinationPoint({ lat: 0, lng: 179.999 }, Math.PI / 2, 1000);
    expect(p.lng).toBeGreaterThanOrEqual(-180);
    expect(p.lng).toBeLessThanOrEqual(180);
    expect(p.lng).toBeLessThan(0); // wrapped west
  });
});

describe("seed, commitment and reveal", () => {
  it("generates 32 bytes of CSPRNG hex, never repeating", () => {
    const a = generateSeed();
    const b = generateSeed();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it("derives a seed that is reproducible at reveal time but not guessable", () => {
    const seed = deriveSeed("s3cret", "spawn_1");
    expect(deriveSeed("s3cret", "spawn_1")).toBe(seed);
    expect(deriveSeed("s3cret", "spawn_2")).not.toBe(seed);
    expect(deriveSeed("other", "spawn_1")).not.toBe(seed);
    expect(seed).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses to derive from an empty secret rather than producing a stable seed", () => {
    expect(() => deriveSeed("", "spawn_1")).toThrow();
    expect(() => deriveSeed("s3cret", "")).toThrow();
  });

  it("commits and verifies", () => {
    const seed = generateSeed();
    const commit = commitSeed(seed);
    expect(commit).toMatch(/^[0-9a-f]{64}$/);
    expect(verifySeed(seed, commit)).toBe(true);
    expect(verifySeed(generateSeed(), commit)).toBe(false);
  });
});

describe("uniformBigInt", () => {
  it("is deterministic in the seed", () => {
    expect(uniformBigInt("seed-a", "amount", 1n, 1_000_000n)).toBe(
      uniformBigInt("seed-a", "amount", 1n, 1_000_000n),
    );
  });

  it("stays inside the inclusive bounds and can reach both ends", () => {
    const min = 10n ** 15n;
    const max = 2n * 10n ** 15n;
    let sawLowHalf = false;
    let sawHighHalf = false;
    for (let i = 0; i < 400; i += 1) {
      const v = uniformBigInt(`seed-${i}`, "amount", min, max);
      expect(v).toBeGreaterThanOrEqual(min);
      expect(v).toBeLessThanOrEqual(max);
      if (v < min + (max - min) / 2n) sawLowHalf = true;
      else sawHighHalf = true;
    }
    expect(sawLowHalf && sawHighHalf).toBe(true);
  });

  it("does not lean toward the low end the way modulo does", () => {
    // Rejection sampling vs `x % range`: modulo bias would show as a
    // systematic tilt, which on a payout is money the treasury quietly keeps.
    const min = 0n;
    const max = 999n;
    let low = 0;
    const runs = 3000;
    for (let i = 0; i < runs; i += 1) {
      if (uniformBigInt(`bias-${i}`, "amount", min, max) < 500n) low += 1;
    }
    expect(low / runs).toBeGreaterThan(0.45);
    expect(low / runs).toBeLessThan(0.55);
  });

  it("handles a degenerate single-value range and rejects an inverted one", () => {
    expect(uniformBigInt("s", "l", 7n, 7n)).toBe(7n);
    expect(() => uniformBigInt("s", "l", 9n, 8n)).toThrow(RangeError);
  });
});

describe("deriveSpawn", () => {
  const params = {
    origin: ORIGIN,
    minRadiusM: 80,
    maxRadiusM: 600,
    minWei: 500_000_000_000_000n, // 0.0005 MON
    maxWei: 1_500_000_000_000_000n, // 0.0015 MON
  };

  it("is a pure function of the seed, so a revealed seed proves the draw", () => {
    const seed = "deadbeef".repeat(8);
    expect(deriveSpawn(seed, params)).toEqual(deriveSpawn(seed, params));
  });

  it("places every draw inside the configured annulus", () => {
    for (let i = 0; i < 300; i += 1) {
      const draw = deriveSpawn(`seed-${i}`, params);
      const d = haversineMeters(ORIGIN, draw);
      expect(d).toBeGreaterThanOrEqual(params.minRadiusM - 0.5);
      expect(d).toBeLessThanOrEqual(params.maxRadiusM + 0.5);
      expect(draw.amountWei).toBeGreaterThanOrEqual(params.minWei);
      expect(draw.amountWei).toBeLessThanOrEqual(params.maxWei);
    }
  });

  it("never places a spawn on top of the player", () => {
    // spawnMinRadiusM is what makes collecting one cost real movement.
    for (let i = 0; i < 200; i += 1) {
      expect(
        haversineMeters(ORIGIN, deriveSpawn(`m-${i}`, params)),
      ).toBeGreaterThan(50);
    }
  });

  it("spreads bearings around the full circle", () => {
    const quadrants = new Set<number>();
    for (let i = 0; i < 200; i += 1) {
      quadrants.add(Math.floor(deriveSpawn(`b-${i}`, params).bearingDeg / 90));
    }
    expect(quadrants.size).toBe(4);
  });

  it("rejects misconfigured bounds instead of drawing something arbitrary", () => {
    expect(() => deriveSpawn("s", { ...params, maxRadiusM: 10 })).toThrow(
      RangeError,
    );
    expect(() =>
      deriveSpawn("s", { ...params, minRadiusM: Number.NaN }),
    ).toThrow(RangeError);
    expect(() => deriveSpawn("s", { ...params, maxWei: 1n })).toThrow(
      RangeError,
    );
    expect(() => deriveSpawn("s", { ...params, minWei: -1n })).toThrow(
      RangeError,
    );
  });
});

// ---------------------------------------------------------------------------

function eligibility(
  over: Partial<SpawnEligibilityContext> = {},
): SpawnEligibilityContext {
  return {
    serverNow: NOW,
    playerActive: true,
    huntActive: true,
    spawnEnabled: true,
    huntStartsAt: new Date("2026-08-01T00:00:00.000Z"),
    huntEndsAt: new Date("2026-09-01T00:00:00.000Z"),
    lastVerifiedLat: ORIGIN.lat,
    lastVerifiedLng: ORIGIN.lng,
    lastVerifiedAt: new Date(NOW.getTime() - 60_000),
    lastSpawnAt: null,
    hasActiveSpawn: false,
    spawnCooldownSeconds: 600,
    spawnMinRadiusM: 80,
    spawnMaxRadiusM: 600,
    spawnMinWei: 500_000_000_000_000n,
    spawnMaxWei: 1_500_000_000_000_000n,
    maxVerifiedAgeSeconds: 900,
    ...over,
  };
}

describe("deriveSpawnInArea", () => {
  const params = {
    origin: ORIGIN,
    minRadiusM: 80,
    maxRadiusM: 600,
    minWei: 500_000_000_000_000n,
    maxWei: 1_500_000_000_000_000n,
  };

  // Everything EAST of the origin only. Roughly half the bearings land outside,
  // so the redraw path is genuinely exercised rather than trivially satisfied.
  const EAST_HALF: Ring = [
    { lat: ORIGIN.lat - 0.01, lng: ORIGIN.lng },
    { lat: ORIGIN.lat - 0.01, lng: ORIGIN.lng + 0.01 },
    { lat: ORIGIN.lat + 0.01, lng: ORIGIN.lng + 0.01 },
    { lat: ORIGIN.lat + 0.01, lng: ORIGIN.lng },
  ];
  const area = { include: [EAST_HALF], exclude: [] as Ring[] };

  it("is reproducible, so a revealed seed still proves the whole retry sequence", () => {
    expect(deriveSpawnInArea("seed-42", params, area)).toEqual(
      deriveSpawnInArea("seed-42", params, area),
    );
  });

  it("never returns a draw outside the walkable area", () => {
    for (let i = 0; i < 300; i += 1) {
      const result = deriveSpawnInArea(`seed-${i}`, params, area);
      if (!result.ok) continue;
      expect(isWalkable(result.draw, area)).toBe(true);
    }
  });

  it("still respects the annulus it was asked for", () => {
    for (let i = 0; i < 200; i += 1) {
      const result = deriveSpawnInArea(`annulus-${i}`, params, area);
      if (!result.ok) continue;
      const d = haversineMeters(ORIGIN, result.draw);
      expect(d).toBeGreaterThanOrEqual(params.minRadiusM - 0.5);
      expect(d).toBeLessThanOrEqual(params.maxRadiusM + 0.5);
    }
  });

  it("takes the first draw untouched when it is already walkable", () => {
    // Find a seed whose attempt 0 lands east, then prove no redraw happened.
    const seed = Array.from({ length: 50 }, (_, i) => `first-${i}`).find((s) =>
      isWalkable(deriveSpawn(s, params), area),
    )!;
    const result = deriveSpawnInArea(seed, params, area);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attempts).toBe(1);
      expect(result.draw).toEqual(deriveSpawn(seed, params));
    }
  });

  it("reports how many attempts it needed, within the bound", () => {
    for (let i = 0; i < 100; i += 1) {
      const result = deriveSpawnInArea(`attempts-${i}`, params, area, 6);
      expect(result.attempts).toBeGreaterThanOrEqual(1);
      expect(result.attempts).toBeLessThanOrEqual(6);
    }
  });

  // An unsurveyed hunt places nothing. This is the whole reason `isWalkable`
  // treats an empty hull as "nowhere approved" rather than "anywhere goes".
  it("declines when no walkable area has been surveyed", () => {
    const result = deriveSpawnInArea("unsurveyed", params, {
      include: [],
      exclude: [],
    });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(10);
  });

  // A player standing across the river from the only walkable ground. Missing a
  // spawn cycle is correct here; spinning forever in a request path is not.
  it("declines rather than looping when the hull is out of reach", () => {
    const faraway: Ring = [
      { lat: ORIGIN.lat + 1, lng: ORIGIN.lng + 1 },
      { lat: ORIGIN.lat + 1, lng: ORIGIN.lng + 1.01 },
      { lat: ORIGIN.lat + 1.01, lng: ORIGIN.lng + 1.01 },
      { lat: ORIGIN.lat + 1.01, lng: ORIGIN.lng + 1 },
    ];
    const result = deriveSpawnInArea("unreachable", params, {
      include: [faraway],
      exclude: [],
    });
    expect(result.ok).toBe(false);
  });

  // THE POINT: a hazard inside the hull stays unreachable.
  it("never places a drop inside an exclusion zone", () => {
    const river: Ring = [
      { lat: ORIGIN.lat - 0.01, lng: ORIGIN.lng + 0.002 },
      { lat: ORIGIN.lat - 0.01, lng: ORIGIN.lng + 0.004 },
      { lat: ORIGIN.lat + 0.01, lng: ORIGIN.lng + 0.004 },
      { lat: ORIGIN.lat + 0.01, lng: ORIGIN.lng + 0.002 },
    ];
    const withRiver = { include: [EAST_HALF], exclude: [river] };

    for (let i = 0; i < 300; i += 1) {
      const result = deriveSpawnInArea(`river-${i}`, params, withRiver);
      if (!result.ok) continue;
      expect(isWalkable(result.draw, withRiver)).toBe(true);
    }
  });

  it("refuses a nonsensical attempt bound", () => {
    expect(() => deriveSpawnInArea("s", params, area, 0)).toThrow(RangeError);
    expect(() => deriveSpawnInArea("s", params, area, 1.5)).toThrow(RangeError);
  });
});

describe("evaluateSpawnEligibility", () => {
  it("anchors on the last VERIFIED position, never on a claim", () => {
    const res = evaluateSpawnEligibility(eligibility());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.origin).toEqual(ORIGIN);
  });

  it.each([
    ["spawn_disabled", { spawnEnabled: false }],
    ["player_not_active", { playerActive: false }],
    ["hunt_not_active", { huntActive: false }],
    [
      "hunt_not_started",
      { huntStartsAt: new Date("2026-12-01T00:00:00.000Z") },
    ],
    ["hunt_ended", { huntEndsAt: new Date("2026-01-01T00:00:00.000Z") }],
    ["no_verified_position", { lastVerifiedLat: null }],
    ["no_verified_position", { lastVerifiedAt: null }],
    ["no_verified_position", { lastVerifiedLng: Number.NaN }],
    [
      "stale_verified_position",
      { lastVerifiedAt: new Date(NOW.getTime() - 3_600_000) },
    ],
    ["spawn_already_active", { hasActiveSpawn: true }],
    ["spawn_cooldown", { lastSpawnAt: new Date(NOW.getTime() - 60_000) }],
    ["spawn_bounds_misconfigured", { spawnMinWei: 0n }],
    ["spawn_bounds_misconfigured", { spawnMaxWei: 0n }],
    ["spawn_bounds_misconfigured", { spawnMinRadiusM: 0 }],
    ["spawn_bounds_misconfigured", { spawnMaxRadiusM: 10 }],
  ])("denies with %s", (reason, over) => {
    const res = evaluateSpawnEligibility(
      eligibility(over as Partial<SpawnEligibilityContext>),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe(reason);
  });

  it("denies a verified fix dated in the future rather than treating it as fresh", () => {
    const res = evaluateSpawnEligibility(
      eligibility({ lastVerifiedAt: new Date(NOW.getTime() + 600_000) }),
    );
    expect(res.ok).toBe(false);
  });

  it("allows a spawn once the cooldown has elapsed", () => {
    const res = evaluateSpawnEligibility(
      eligibility({ lastSpawnAt: new Date(NOW.getTime() - 601_000) }),
    );
    expect(res.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------

const SPAWN_POINT = destinationPoint(ORIGIN, 1.2, 300);

function collect(over: Partial<SpawnCollectContext> = {}): SpawnCollectContext {
  return {
    attempt: {
      lat: SPAWN_POINT.lat,
      lng: SPAWN_POINT.lng,
      accuracyM: 12,
      clientTs: NOW,
    },
    serverNow: NOW,
    playerId: "player_1",
    playerActive: true,
    huntActive: true,
    huntStartsAt: null,
    huntEndsAt: null,
    spawn: {
      id: "spawn_1",
      playerId: "player_1",
      lat: SPAWN_POINT.lat,
      lng: SPAWN_POINT.lng,
      radiusMeters: 25,
      expiresAt: new Date(NOW.getTime() + 300_000),
      collectedAt: null,
    },
    lastAccepted: null,
    rules: {
      maxAccuracyM: 30,
      maxSpeedKmh: 60,
      cooldownSeconds: 60,
      maxClockSkewSeconds: 120,
    },
    ...over,
  };
}

describe("validateSpawnCollect", () => {
  it("accepts a player standing on the spawn", () => {
    const res = validateSpawnCollect(collect());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.spawnId).toBe("spawn_1");
      expect(res.distanceMeters).toBeLessThan(1);
    }
  });

  it("applies the SAME checks a cache claim gets — not a weaker set", () => {
    const cases: Array<[string, Partial<SpawnCollectContext>, boolean]> = [
      ["player_not_active", { playerActive: false }, false],
      ["hunt_not_active", { huntActive: false }, false],
      [
        "gps_accuracy_too_low",
        { attempt: { ...collect().attempt, accuracyM: null } },
        false,
      ],
      [
        "gps_accuracy_too_low",
        { attempt: { ...collect().attempt, accuracyM: 45 } },
        false,
      ],
      [
        "clock_skew",
        {
          attempt: {
            ...collect().attempt,
            clientTs: new Date(NOW.getTime() + 600_000),
          },
        },
        true,
      ],
      [
        "cooldown",
        {
          lastAccepted: {
            lat: SPAWN_POINT.lat,
            lng: SPAWN_POINT.lng,
            at: new Date(NOW.getTime() - 10_000),
          },
        },
        false,
      ],
      [
        "implausible_speed",
        {
          // 40 km away, 61 seconds ago: past the cooldown, far past any walk.
          lastAccepted: {
            lat: ORIGIN.lat + 0.4,
            lng: ORIGIN.lng,
            at: new Date(NOW.getTime() - 61_000),
          },
        },
        true,
      ],
    ];

    for (const [reason, over, flagged] of cases) {
      const res = validateSpawnCollect(collect(over));
      expect(res.ok, reason).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe(reason);
        expect(res.flagged).toBe(flagged);
      }
    }
  });

  it("treats an unknown accuracy as unusable, not as perfect", () => {
    const res = validateSpawnCollect(
      collect({ attempt: { ...collect().attempt, accuracyM: null } }),
    );
    expect(res.ok).toBe(false);
  });

  it("rejects a NaN accuracy — the comparison is written so it cannot slip through", () => {
    const res = validateSpawnCollect(
      collect({ attempt: { ...collect().attempt, accuracyM: Number.NaN } }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("gps_accuracy_too_low");
  });

  it("rejects an expired spawn", () => {
    const base = collect();
    const res = validateSpawnCollect(
      collect({
        spawn: { ...base.spawn!, expiresAt: new Date(NOW.getTime() - 1) },
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("spawn_expired");
  });

  it("rejects an already-collected spawn", () => {
    const base = collect();
    const res = validateSpawnCollect(
      collect({ spawn: { ...base.spawn!, collectedAt: NOW } }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("spawn_already_collected");
  });

  it("refuses another player's spawn, and flags the attempt", () => {
    const base = collect();
    const res = validateSpawnCollect(
      collect({ spawn: { ...base.spawn!, playerId: "player_2" } }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("spawn_not_found");
      expect(res.flagged).toBe(true);
    }
  });

  it("rejects a missing spawn", () => {
    const res = validateSpawnCollect(collect({ spawn: null }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("spawn_not_found");
  });

  it("rejects a player standing outside the spawn radius", () => {
    const away = destinationPoint(SPAWN_POINT, 0, 200);
    const res = validateSpawnCollect(
      collect({
        attempt: { ...collect().attempt, lat: away.lat, lng: away.lng },
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("out_of_range");
  });

  it("accepts a plausible walk between two accepted positions", () => {
    const res = validateSpawnCollect(
      collect({
        lastAccepted: {
          lat: ORIGIN.lat,
          lng: ORIGIN.lng,
          at: new Date(NOW.getTime() - 300_000), // 300m in 5 minutes
        },
      }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.speedKmh).toBeLessThan(10);
  });
});
