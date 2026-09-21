import { describe, expect, it } from "vitest";
import {
  MAX_CACHES_PER_HUNT,
  MAX_CACHE_RADIUS_M,
  MAX_HUNTS_PER_PLAYER,
  MIN_CACHE_RADIUS_M,
  MIN_CACHE_SEPARATION_M,
  explainPlantRefusal,
  mayCreateHunt,
  mayPlantCache,
  validCoordinates,
  validRadius,
} from "./sembrador";
import type { LatLng } from "@/lib/geo/distance";

/** Tierra Colorada, roughly. */
const HERE: LatLng = { lat: 17.1614, lng: -99.5253 };

/** A point `metres` due north of `from`. 1 degree of latitude ≈ 111_320 m. */
function north(from: LatLng, metres: number): LatLng {
  return { lat: from.lat + metres / 111_320, lng: from.lng };
}

function plant(over: Partial<Parameters<typeof mayPlantCache>[0]> = {}) {
  return mayPlantCache({
    lat: HERE.lat,
    lng: HERE.lng,
    radiusMeters: 25,
    existing: [],
    ...over,
  });
}

describe("how many hunts one wallet may open", () => {
  it("allows up to the cap and refuses past it", () => {
    expect(mayCreateHunt(0).ok).toBe(true);
    expect(mayCreateHunt(MAX_HUNTS_PER_PLAYER - 1).ok).toBe(true);
    expect(mayCreateHunt(MAX_HUNTS_PER_PLAYER)).toEqual({
      ok: false,
      reason: "too_many_hunts",
    });
  });
});

describe("coordinates have to be a place somebody could stand", () => {
  it("accepts an ordinary point", () => {
    expect(validCoordinates(HERE.lat, HERE.lng).ok).toBe(true);
  });

  it("refuses values outside the globe", () => {
    for (const [lat, lng] of [
      [91, 0],
      [-91, 0],
      [0, 181],
      [0, -181],
    ]) {
      expect(validCoordinates(lat, lng)).toEqual({
        ok: false,
        reason: "bad_coordinates",
      });
    }
  });

  it("refuses NaN and Infinity", () => {
    expect(validCoordinates(Number.NaN, 0).ok).toBe(false);
    expect(validCoordinates(0, Number.POSITIVE_INFINITY).ok).toBe(false);
  });

  it("refuses null island specifically", () => {
    // (0, 0) is in the Gulf of Guinea and is almost always an unfilled field.
    // Accepting it plants a cache in the ocean and reports success.
    expect(validCoordinates(0, 0)).toEqual({
      ok: false,
      reason: "null_island",
    });
    // A real point on the equator or the meridian is still fine.
    expect(validCoordinates(0, -99.5).ok).toBe(true);
    expect(validCoordinates(17.1, 0).ok).toBe(true);
  });
});

describe("radius bounds", () => {
  it("accepts the endpoints and refuses outside them", () => {
    expect(validRadius(MIN_CACHE_RADIUS_M).ok).toBe(true);
    expect(validRadius(MAX_CACHE_RADIUS_M).ok).toBe(true);
    expect(validRadius(MIN_CACHE_RADIUS_M - 1).ok).toBe(false);
    expect(validRadius(MAX_CACHE_RADIUS_M + 1).ok).toBe(false);
  });

  it("refuses a fractional radius", () => {
    expect(validRadius(25.5)).toEqual({
      ok: false,
      reason: "radius_out_of_range",
    });
  });
});

describe("caches must be far enough apart to require walking", () => {
  it("refuses a cache stacked on an existing one", () => {
    // The abuse this prevents: fifty caches on one bench, and a player who
    // never moves collects the whole hunt. That turns a walking game into a
    // faucet and a funded budget into one person's withdrawal.
    expect(plant({ existing: [HERE] })).toEqual({
      ok: false,
      reason: "too_close_to_existing",
    });
  });

  it("refuses one just inside the separation", () => {
    expect(
      plant({ existing: [north(HERE, MIN_CACHE_SEPARATION_M - 5)] }),
    ).toEqual({ ok: false, reason: "too_close_to_existing" });
  });

  it("accepts one just outside it", () => {
    expect(
      plant({ existing: [north(HERE, MIN_CACHE_SEPARATION_M + 5)] }).ok,
    ).toBe(true);
  });

  it("checks against EVERY existing cache, not just the nearest few", () => {
    const far = [1, 2, 3, 4].map((i) => north(HERE, 500 * i));
    // One close cache hidden among distant ones must still refuse.
    expect(plant({ existing: [...far, north(HERE, 10)] }).ok).toBe(false);
    expect(plant({ existing: far }).ok).toBe(true);
  });
});

describe("hunt capacity", () => {
  it("refuses once the hunt is full", () => {
    // Spread far enough apart that separation is not what refuses them.
    const full = Array.from({ length: MAX_CACHES_PER_HUNT }, (_, i) =>
      north(HERE, 1000 * (i + 1)),
    );
    expect(plant({ existing: full })).toEqual({
      ok: false,
      reason: "hunt_full",
    });
  });
});

describe("the order refusals are reported in", () => {
  it("reports bad coordinates before capacity", () => {
    // A Sembrador with a full hunt AND a broken coordinate should be told the
    // thing they can act on first, not sent to delete a cache over a typo.
    const full = Array.from({ length: MAX_CACHES_PER_HUNT }, (_, i) =>
      north(HERE, 1000 * (i + 1)),
    );
    expect(plant({ lat: 0, lng: 0, existing: full })).toEqual({
      ok: false,
      reason: "null_island",
    });
  });
});

describe("refusals are explained in both languages", () => {
  it("says something different in each, for every reason", () => {
    const reasons = [
      "too_many_hunts",
      "hunt_full",
      "bad_coordinates",
      "null_island",
      "radius_out_of_range",
      "too_close_to_existing",
    ] as const;
    for (const r of reasons) {
      const es = explainPlantRefusal(r, "es");
      const en = explainPlantRefusal(r, "en");
      expect(es.length).toBeGreaterThan(0);
      expect(en.length).toBeGreaterThan(0);
      expect(es).not.toBe(en);
    }
  });

  it("puts the actual numbers in the message", () => {
    // "Too close" without saying how far is not something anybody can fix.
    expect(explainPlantRefusal("too_close_to_existing", "en")).toContain(
      String(MIN_CACHE_SEPARATION_M),
    );
    expect(explainPlantRefusal("hunt_full", "es")).toContain(
      String(MAX_CACHES_PER_HUNT),
    );
  });
});

// ---------------------------------------------------------------------------
// The budget rule.
//
// `rewardCreditWei: 0` was hardcoded in the public plant route with a comment
// explaining why: "a cache that promised credit the hunt has no budget for
// would fail at claim time, after the walk." That was correct when every hunt
// had budgetCreditWei = 0. Hunts can be funded now, so the honest fix is to
// check the budget rather than to refuse every reward.
// ---------------------------------------------------------------------------
describe("mayPlantCache — reward against budget", () => {
  const wmon = (n: number) => BigInt(n) * 10n ** 18n;
  const at = (lat: number, lng: number) => ({ lat, lng });
  const plant = (reward?: Parameters<typeof mayPlantCache>[0]["reward"]) =>
    mayPlantCache({ lat: 17.25, lng: -99.52, radiusMeters: 25, existing: [], reward });

  it("plants when the hunt can pay for it", () => {
    expect(
      plant({
        rewardCreditWei: wmon(1),
        plantedCreditWei: wmon(100),
        budgetCreditWei: wmon(973),
        spentCreditWei: 0n,
      }),
    ).toEqual({ ok: true });
  });

  it("refuses a reward the hunt cannot pay — the walk-then-fail case", () => {
    expect(
      plant({
        rewardCreditWei: wmon(1),
        plantedCreditWei: wmon(973),
        budgetCreditWei: wmon(973),
        spentCreditWei: 0n,
      }),
    ).toEqual({ ok: false, reason: "reward_exceeds_budget" });
  });

  it("counts credit ALREADY SPENT against what is left", () => {
    // A hunt half-claimed has half the budget. Measuring against the budget
    // rather than the remainder would let a hunt be topped up with promises it
    // has already paid out.
    expect(
      plant({
        rewardCreditWei: wmon(10),
        plantedCreditWei: 0n,
        budgetCreditWei: wmon(973),
        spentCreditWei: wmon(970),
      }),
    ).toEqual({ ok: false, reason: "reward_exceeds_budget" });
  });

  it("refuses everything when the hunt is unfunded", () => {
    // The state every hunt was in when the zero was hardcoded.
    expect(
      plant({
        rewardCreditWei: 1n,
        plantedCreditWei: 0n,
        budgetCreditWei: 0n,
        spentCreditWei: 0n,
      }),
    ).toEqual({ ok: false, reason: "reward_exceeds_budget" });
  });

  it("leaves zero-reward planting alone — the public route is unchanged", () => {
    // Sembradores plant at 0 and must keep working on an unfunded hunt.
    expect(
      plant({
        rewardCreditWei: 0n,
        plantedCreditWei: 0n,
        budgetCreditWei: 0n,
        spentCreditWei: 0n,
      }),
    ).toEqual({ ok: true });
    expect(plant(undefined)).toEqual({ ok: true });
  });

  it("does not multiply by player count, deliberately", () => {
    // One full sweep by one player. Multiplying by enrolment would refuse a
    // sound hunt the moment a second person joined, and the claim-time ceiling
    // is the real authority anyway.
    expect(
      plant({
        rewardCreditWei: wmon(100),
        plantedCreditWei: wmon(800),
        budgetCreditWei: wmon(973),
        spentCreditWei: 0n,
      }),
    ).toEqual({ ok: true });
  });

  it("still checks geography first — a reward cannot buy past the spacing rule", () => {
    // Order matters: an over-budget cache 5m from another should report the
    // spacing problem, not the money one, because that is the one a Sembrador
    // can act on by moving.
    const r = mayPlantCache({
      lat: 17.25,
      lng: -99.52,
      radiusMeters: 25,
      existing: [at(17.25001, -99.52001)],
      reward: {
        rewardCreditWei: wmon(9999),
        plantedCreditWei: 0n,
        budgetCreditWei: 0n,
        spentCreditWei: 0n,
      },
    });
    expect(r).toEqual({ ok: false, reason: "too_close_to_existing" });
  });

  it("explains itself in both languages", () => {
    expect(explainPlantRefusal("reward_exceeds_budget", "es")).toMatch(/presupuesto/i);
    expect(explainPlantRefusal("reward_exceeds_budget", "en")).toMatch(/budget/i);
  });
});
