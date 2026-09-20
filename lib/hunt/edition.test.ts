import { describe, expect, it } from "vitest";
import {
  canAfford,
  canonicalOrder,
  deriveEdition,
  heldKey,
  placeableFor,
  quotedPrice,
  type EditionOffer,
} from "./edition";
import { haversineMeters } from "@/lib/geo/distance";

/* ---------------------------------------------------------------------------
   What these tests are for.

   The commit-reveal promises that the drop — position AND which work — was
   fixed before the player moved. That promise is only worth anything if a
   revealed seed genuinely reproduces the same draw, so most of what follows is
   about replay rather than about happy paths.
--------------------------------------------------------------------------- */

const REG = "0x42EbcD44C2295702130f0A641633c691bA5f9480";

function offer(
  masterId: string,
  over: Partial<EditionOffer> = {},
): EditionOffer {
  return {
    collection: REG,
    masterId,
    kind: "MUSIC",
    tier: "STANDARD",
    terms: "PURCHASE",
    priceWei: 1_000_000_000_000_000n,
    ...over,
  };
}

const ORIGIN = { lat: 17.5506, lng: -99.5006 };
const PARAMS = {
  origin: ORIGIN,
  minRadiusM: 40,
  maxRadiusM: 300,
  catalogue: [offer("m1"), offer("m2"), offer("m3"), offer("m4")],
};

describe("deriveEdition", () => {
  it("is a pure function of the seed", () => {
    const a = deriveEdition("seed-one", PARAMS);
    const b = deriveEdition("seed-one", PARAMS);
    expect(a).toEqual(b);
  });

  it("gives a different draw for a different seed", () => {
    const a = deriveEdition("seed-one", PARAMS);
    const b = deriveEdition("seed-two", PARAMS);
    expect({ lat: a.lat, lng: a.lng }).not.toEqual({ lat: b.lat, lng: b.lng });
  });

  // The reveal is worthless if the caller's ordering can change the answer:
  // "the seed chose index 3" proves nothing when index 3 was a different work
  // yesterday. This is the test that makes canonicalOrder load-bearing.
  it("picks the same work however the catalogue was ordered", () => {
    const shuffled = {
      ...PARAMS,
      catalogue: [offer("m3"), offer("m1"), offer("m4"), offer("m2")],
    };
    const a = deriveEdition("replay-me", PARAMS);
    const b = deriveEdition("replay-me", shuffled);
    expect(b.offer.masterId).toBe(a.offer.masterId);
    expect(b.lat).toBe(a.lat);
    expect(b.lng).toBe(a.lng);
  });

  it("lands inside the annulus, never on top of the player", () => {
    for (let i = 0; i < 200; i += 1) {
      const d = deriveEdition(`walk-${i}`, PARAMS);
      const metres = haversineMeters(ORIGIN, { lat: d.lat, lng: d.lng });
      expect(metres).toBeGreaterThanOrEqual(PARAMS.minRadiusM - 0.5);
      expect(metres).toBeLessThanOrEqual(PARAMS.maxRadiusM + 0.5);
      // And the reported distance must match where it actually put the point,
      // or the card lies about how far the walk is.
      expect(Math.abs(metres - d.distanceM)).toBeLessThan(0.5);
    }
  });

  it("reaches every work in the catalogue", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i += 1) {
      seen.add(deriveEdition(`spread-${i}`, PARAMS).offer.masterId);
    }
    expect(seen).toEqual(new Set(["m1", "m2", "m3", "m4"]));
  });

  it("only ever offers a work that was in the catalogue", () => {
    const only = { ...PARAMS, catalogue: [offer("solo")] };
    for (let i = 0; i < 20; i += 1) {
      expect(deriveEdition(`s-${i}`, only).offer.masterId).toBe("solo");
    }
  });

  it("refuses to invent a work when the catalogue is empty", () => {
    expect(() => deriveEdition("x", { ...PARAMS, catalogue: [] })).toThrow(
      /catalogue is empty/,
    );
  });

  it("rejects impossible radii rather than drawing something", () => {
    expect(() => deriveEdition("x", { ...PARAMS, minRadiusM: -1 })).toThrow(
      RangeError,
    );
    expect(() =>
      deriveEdition("x", { ...PARAMS, minRadiusM: 500, maxRadiusM: 100 }),
    ).toThrow(RangeError);
  });
});

describe("canonicalOrder", () => {
  it("is stable and does not mutate the caller's array", () => {
    const input = [offer("b"), offer("a")];
    const copy = [...input];
    const out = canonicalOrder(input);
    expect(out.map((o) => o.masterId)).toEqual(["a", "b"]);
    expect(input).toEqual(copy);
  });

  it("separates the two tiers of the same master", () => {
    const out = canonicalOrder([
      offer("m1", { tier: "STANDARD" }),
      offer("m1", { tier: "COLLECTOR" }),
    ]);
    expect(out.map((o) => o.tier)).toEqual(["COLLECTOR", "STANDARD"]);
  });

  it("separates the same master id in different collections", () => {
    const out = canonicalOrder([
      offer("m1", { collection: "0xBBB" }),
      offer("m1", { collection: "0xAAA" }),
    ]);
    expect(out.map((o) => o.collection)).toEqual(["0xAAA", "0xBBB"]);
  });
});

describe("quotedPrice", () => {
  it("is zero for a free work", () => {
    expect(quotedPrice(offer("m", { terms: "FREE", priceWei: null }))).toBe(0n);
  });

  it("is the offer price for a purchase", () => {
    expect(quotedPrice(offer("m", { priceWei: 42n }))).toBe(42n);
  });

  // The database CHECK forbids these shapes; this is the same rule in code, so
  // a malformed catalogue read cannot reach a hunter as a free work.
  it("refuses a purchase with no price", () => {
    expect(() => quotedPrice(offer("m", { priceWei: null }))).toThrow(
      /no positive price/,
    );
  });

  it("refuses a purchase priced at zero", () => {
    expect(() => quotedPrice(offer("m", { priceWei: 0n }))).toThrow(
      /no positive price/,
    );
  });
});

describe("canAfford", () => {
  it("allows exactly enough", () => {
    expect(canAfford(100n, 100n)).toEqual({ ok: true, shortfallWei: 0n });
  });

  it("reports the shortfall rather than just refusing", () => {
    expect(canAfford(40n, 100n)).toEqual({ ok: false, shortfallWei: 60n });
  });

  it("treats a free work as affordable at zero balance", () => {
    expect(canAfford(0n, 0n)).toEqual({ ok: true, shortfallWei: 0n });
  });

  it("refuses a negative price rather than crediting the hunter", () => {
    expect(() => canAfford(100n, -1n)).toThrow(RangeError);
  });
});

describe("placeableFor", () => {
  const ONE_MON = 1_000_000_000_000_000_000n;
  const GAS = ONE_MON / 20n; // 0.05 MON of headroom
  const cheap = offer("dime", { priceWei: ONE_MON });
  const dear = offer("suddenly", { priceWei: 300n * ONE_MON });
  const gift = offer("promo", { terms: "FREE", priceWei: null });
  const none = new Set<string>();

  it("offers only what the hunter can pay for, gas included", () => {
    // Exactly the price is NOT enough — sending it costs gas.
    expect(placeableFor([cheap, dear], none, ONE_MON, GAS)).toEqual([]);
    expect(
      placeableFor([cheap, dear], none, ONE_MON + GAS, GAS).map(
        (o) => o.masterId,
      ),
    ).toEqual(["dime"]);
  });

  // The whole point of a giveaway is reaching someone with nothing.
  it("offers a FREE work at a zero balance", () => {
    expect(placeableFor([cheap, dear, gift], none, 0n, GAS)).toEqual([gift]);
  });

  it("never offers a work the passkey already holds", () => {
    const held = new Set([heldKey(cheap)]);
    expect(placeableFor([cheap], held, 1000n * ONE_MON, GAS)).toEqual([]);
  });

  // Tier is in the key, so owning the standard must not bar the collector.
  it("still offers the other tier of a work they hold", () => {
    const std = offer("dime", { tier: "STANDARD", priceWei: ONE_MON });
    const col = offer("dime", { tier: "COLLECTOR", priceWei: 2n * ONE_MON });
    const held = new Set([heldKey(std)]);
    expect(
      placeableFor([std, col], held, 1000n * ONE_MON, GAS).map((o) => o.tier),
    ).toEqual(["COLLECTOR"]);
  });

  it("returns nothing rather than throwing when all are unaffordable", () => {
    expect(placeableFor([dear], none, 0n, GAS)).toEqual([]);
  });
});
