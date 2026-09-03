import { describe, expect, it } from "vitest";
import {
  validateClaim,
  validatePosition,
  type PositionContext,
} from "./validator";

const NOW = new Date("2026-09-02T12:00:00Z");
const HERE = { lat: 17.1614, lng: -99.5253 };

function ctx(over: Partial<PositionContext> = {}): PositionContext {
  return {
    attempt: { ...HERE, accuracyM: 10, clientTs: NOW },
    serverNow: NOW,
    playerActive: true,
    huntActive: true,
    huntStartsAt: null,
    huntEndsAt: null,
    lastFix: null,
    rules: {
      maxAccuracyM: 30,
      maxSpeedKmh: 60,
      cooldownSeconds: 60,
      maxClockSkewSeconds: 120,
    },
    ...over,
  };
}

/** `metres` due north. 1 degree of latitude ≈ 111_320 m. */
function north(metres: number) {
  return { lat: HERE.lat + metres / 111_320, lng: HERE.lng };
}

describe("the very first fix", () => {
  it("is accepted with nothing to compare against", () => {
    // This is the whole point of the feature: a player in a city nobody has
    // seeded has no prior fix, no find, and no cache to walk to. If this
    // rejected, the bootstrap would not exist and spawns could never start.
    const r = validatePosition(ctx({ lastFix: null }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.speedKmh).toBeNull();
  });
});

describe("signal quality", () => {
  it("refuses a device that declined to report accuracy", () => {
    // "Unknown" must never be the permissive branch on a path that unlocks
    // spending.
    const r = validatePosition(
      ctx({ attempt: { ...HERE, accuracyM: null, clientTs: NOW } }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("gps_accuracy_too_low");
  });

  it("refuses accuracy worse than the hunt allows, and accepts the boundary", () => {
    expect(
      validatePosition(
        ctx({ attempt: { ...HERE, accuracyM: 30, clientTs: NOW } }),
      ).ok,
    ).toBe(true);
    expect(
      validatePosition(
        ctx({ attempt: { ...HERE, accuracyM: 30.1, clientTs: NOW } }),
      ).ok,
    ).toBe(false);
  });

  it("refuses NaN accuracy rather than waving it through", () => {
    const r = validatePosition(
      ctx({ attempt: { ...HERE, accuracyM: Number.NaN, clientTs: NOW } }),
    );
    expect(r.ok).toBe(false);
  });
});

describe("clock skew", () => {
  it("flags a device clock steered far from the server's", () => {
    // Timestamps drive the speed check, so a wrong clock is how a teleport is
    // made to look like a walk.
    const far = new Date(NOW.getTime() + 121_000);
    const r = validatePosition(
      ctx({ attempt: { ...HERE, accuracyM: 10, clientTs: far } }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("clock_skew");
      expect(r.flagged).toBe(true);
    }
  });
});

describe("movement plausibility against the last verified fix", () => {
  it("refuses a second fix inside the cooldown", () => {
    const r = validatePosition(
      ctx({
        lastFix: { ...HERE, foundAt: new Date(NOW.getTime() - 30_000) },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("cooldown");
  });

  it("flags a teleport", () => {
    // 10 km in 61 seconds is ~590 km/h.
    const r = validatePosition(
      ctx({
        lastFix: {
          ...north(10_000),
          foundAt: new Date(NOW.getTime() - 61_000),
        },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("implausible_speed");
      expect(r.flagged).toBe(true);
    }
  });

  it("accepts an ordinary walk and reports the speed", () => {
    // 300 m in 10 minutes — about 1.8 km/h.
    const r = validatePosition(
      ctx({
        lastFix: { ...north(300), foundAt: new Date(NOW.getTime() - 600_000) },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.speedKmh).not.toBeNull();
      expect(r.speedKmh!).toBeLessThan(5);
    }
  });
});

describe("eligibility", () => {
  it("refuses a suspended player before anything else", () => {
    const r = validatePosition(
      ctx({
        playerActive: false,
        attempt: { ...HERE, accuracyM: 999, clientTs: NOW },
      }),
    );
    expect(r.ok).toBe(false);
    // Not the accuracy: an ineligible player learns nothing about the rules.
    if (!r.ok) expect(r.reason).toBe("player_not_active");
  });

  it("refuses an inactive, unopened, or closed hunt", () => {
    expect(validatePosition(ctx({ huntActive: false })).ok).toBe(false);
    expect(
      validatePosition(
        ctx({ huntStartsAt: new Date(NOW.getTime() + 86_400_000) }),
      ).ok,
    ).toBe(false);
    expect(
      validatePosition(
        ctx({ huntEndsAt: new Date(NOW.getTime() - 86_400_000) }),
      ).ok,
    ).toBe(false);
  });
});

describe("a check-in and a claim cannot disagree", () => {
  it("gives the same reason for the same bad position", () => {
    // The reason validatePosition was extracted rather than copied. Two
    // implementations of these rules would eventually drift, and the one that
    // drifts wrong is the one guarding a path that spends.
    const bad: Array<[string, Partial<PositionContext>]> = [
      ["accuracy", { attempt: { ...HERE, accuracyM: 999, clientTs: NOW } }],
      [
        "clock",
        {
          attempt: {
            ...HERE,
            accuracyM: 10,
            clientTs: new Date(NOW.getTime() + 300_000),
          },
        },
      ],
      ["player", { playerActive: false }],
      ["hunt", { huntActive: false }],
      [
        "cooldown",
        { lastFix: { ...HERE, foundAt: new Date(NOW.getTime() - 5_000) } },
      ],
    ];

    for (const [label, over] of bad) {
      const p = validatePosition(ctx(over));
      const base = ctx(over);
      const c = validateClaim({
        ...base,
        playerId: "p1",
        unfoundCaches: [
          { id: "c1", ...HERE, radiusMeters: 25, rewardCreditWei: 0n },
        ],
        foundCacheIds: [],
        lastFind: base.lastFix,
      });
      expect(p.ok, label).toBe(false);
      expect(c.ok, label).toBe(false);
      if (!p.ok && !c.ok) expect(c.reason, label).toBe(p.reason);
    }
  });
});
