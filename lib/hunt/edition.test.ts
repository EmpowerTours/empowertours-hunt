import { describe, expect, it } from "vitest";
import {
  canAfford,
  evaluateEditionEligibility,
  type EditionEligibilityContext,
  canonicalOrder,
  deriveEdition,
  heldKey,
  placeableFor,
  quotedPrice,
  type EditionOffer,
} from "./edition";

/* ---------------------------------------------------------------------------
   What these tests are for.

   An edition is an ENCOUNTER, not a place — a card over the scope, answered
   yes or no from wherever the hunter is standing. So there is nothing here
   about position, proximity or walkable ground: those guard a spawn paying
   the treasury's money for reaching somewhere, and an edition takes the
   hunter's money instead.

   What is still worth pinning is that the choice of work replays from its
   seed, and that nothing can be offered which the hunter already owns or
   cannot pay for.
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

const PARAMS = {
  catalogue: [offer("m1"), offer("m2"), offer("m3"), offer("m4")],
};

describe("deriveEdition", () => {
  it("is a pure function of the seed", () => {
    expect(deriveEdition("seed-one", PARAMS)).toEqual(
      deriveEdition("seed-one", PARAMS),
    );
  });

  // "The seed chose index 3" proves nothing if index 3 was a different work
  // yesterday. This is the test that makes canonicalOrder load-bearing.
  it("picks the same work however the catalogue was ordered", () => {
    const shuffled = {
      catalogue: [offer("m3"), offer("m1"), offer("m4"), offer("m2")],
    };
    expect(deriveEdition("replay-me", shuffled).offer.masterId).toBe(
      deriveEdition("replay-me", PARAMS).offer.masterId,
    );
  });

  it("reaches every work in the catalogue", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i += 1) {
      seen.add(deriveEdition(`spread-${i}`, PARAMS).offer.masterId);
    }
    expect(seen).toEqual(new Set(["m1", "m2", "m3", "m4"]));
  });

  it("only ever offers a work that was in the catalogue", () => {
    const only = { catalogue: [offer("solo")] };
    for (let i = 0; i < 20; i += 1) {
      expect(deriveEdition(`s-${i}`, only).offer.masterId).toBe("solo");
    }
  });

  it("refuses to invent a work when the catalogue is empty", () => {
    expect(() => deriveEdition("x", { catalogue: [] })).toThrow(
      /catalogue is empty/,
    );
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

describe("evaluateEditionEligibility", () => {
  const NOW = new Date("2026-09-20T12:00:00Z");
  const base: EditionEligibilityContext = {
    serverNow: NOW,
    playerActive: true,
    huntActive: true,
    editionsEnabled: true,
    lastEditionAt: null,
    editionCooldownSeconds: 600,
    hasActiveEdition: false,
    placeableCount: 3,
    catalogueUnavailable: false,
  };
  const deny = (over: Partial<EditionEligibilityContext>) => {
    const r = evaluateEditionEligibility({ ...base, ...over });
    return r.ok ? "ALLOWED" : r.reason;
  };

  it("allows a live player with something to offer", () => {
    expect(evaluateEditionEligibility(base).ok).toBe(true);
  });

  it("refuses when editions are switched off", () => {
    expect(deny({ editionsEnabled: false })).toBe("editions_disabled");
  });

  it("refuses a suspended player and a closed hunt", () => {
    expect(deny({ playerActive: false })).toBe("player_not_active");
    expect(deny({ huntActive: false })).toBe("hunt_not_active");
  });

  it("refuses while one is already live, and during the cooldown", () => {
    expect(deny({ hasActiveEdition: true })).toBe("edition_already_active");
    expect(deny({ lastEditionAt: new Date(NOW.getTime() - 60_000) })).toBe(
      "edition_cooldown",
    );
  });

  it("allows once the cooldown has elapsed exactly", () => {
    expect(deny({ lastEditionAt: new Date(NOW.getTime() - 600_000) })).toBe(
      "ALLOWED",
    );
  });

  // "We could not ask" must never reach a player as "you own everything".
  it("keeps unavailable distinct from exhausted", () => {
    expect(deny({ catalogueUnavailable: true, placeableCount: 0 })).toBe(
      "catalogue_unavailable",
    );
    expect(deny({ placeableCount: 0 })).toBe("catalogue_exhausted");
  });

  // Independence is the point: a live spawn is not in this context at all.
  it("needs no position at all", () => {
    expect(
      Object.keys(base).some((k) => /lat|lng|verified|radius/i.test(k)),
    ).toBe(false);
  });

  it("does not consider spawns", () => {
    expect(
      Object.keys(base).some((k) => k.toLowerCase().includes("spawn")),
    ).toBe(false);
  });
});
