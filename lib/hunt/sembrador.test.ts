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
