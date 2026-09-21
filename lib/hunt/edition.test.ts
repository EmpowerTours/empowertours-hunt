import { describe, expect, it } from "vitest";
import {
  canAfford,
  evaluateEditionEligibility,
  type EditionEligibilityContext,
  canonicalOrder,
  deriveEdition,
  heldKey,
  leastRecentlyOffered,
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
    editionsOpenAt: null,
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

  // The complaint this exists for: the cooldown is measured from the last
  // edition, so a player returning after hours cleared it instantly and a
  // full-screen buy card covered the scope before they had taken a step.
  it("refuses during the session warm-up even when the cooldown is clear", () => {
    expect(
      deny({
        lastEditionAt: new Date(NOW.getTime() - 3 * 3600_000),
        editionsOpenAt: new Date(NOW.getTime() + 60_000),
      }),
    ).toBe("edition_warmup");
  });

  it("allows the instant the warm-up expires", () => {
    expect(deny({ editionsOpenAt: NOW })).toBe("ALLOWED");
    expect(deny({ editionsOpenAt: new Date(NOW.getTime() + 1) })).toBe(
      "edition_warmup",
    );
  });

  // The route passes serverNow when there is no PlayerHunt row, so a player
  // who has never checked in must not be handed a card on their first poll.
  it("refuses a player whose warm-up clock starts now", () => {
    expect(deny({ editionsOpenAt: NOW, lastEditionAt: null })).toBe("ALLOWED");
    expect(deny({ editionsOpenAt: new Date(NOW.getTime() + 300_000) })).toBe(
      "edition_warmup",
    );
  });

  // Reject by default (AGENTS.md rule 2): a broken date is "not yet", not
  // "go ahead".
  it("refuses on an unusable warm-up instant", () => {
    expect(deny({ editionsOpenAt: new Date(NaN) })).toBe("edition_warmup");
  });

  // Distinct reasons because they have distinct remedies: wait a moment
  // versus wait ten minutes.
  it("reports the warm-up before the cooldown", () => {
    expect(
      deny({
        editionsOpenAt: new Date(NOW.getTime() + 60_000),
        lastEditionAt: new Date(NOW.getTime() - 60_000),
      }),
    ).toBe("edition_warmup");
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

describe("leastRecentlyOffered", () => {
  const o = (
    masterId: string,
    tier: "STANDARD" | "COLLECTOR" = "STANDARD",
  ): EditionOffer => ({
    collection: "0xreg",
    masterId,
    kind: "MUSIC",
    tier,
    terms: "PURCHASE",
    priceWei: 35n * 10n ** 18n,
  });
  const ids = (xs: readonly EditionOffer[]) => xs.map((x) => x.masterId).sort();

  it("prefers a work never offered over one already seen", () => {
    const seen = new Map([[heldKey(o("8")), 1_000]]);
    expect(ids(leastRecentlyOffered([o("8"), o("10")], seen))).toEqual(["10"]);
  });

  // The live failure: MARINA (master 8) was placed three times out of four,
  // declined twice, because nothing read what had already been shown.
  it("alternates rather than repeating when only two works are reachable", () => {
    const pool = [o("8"), o("10")];
    const seen = new Map<string, number>();
    const drawn: string[] = [];
    for (let t = 1; t <= 6; t++) {
      const narrowed = leastRecentlyOffered(pool, seen);
      // Both are unseen on the first draw, so the tie stands and the seed
      // decides. From the second on there is exactly one oldest.
      expect(narrowed.length).toBe(t === 1 ? 2 : 1);
      const pick = narrowed[0]!;
      drawn.push(pick.masterId);
      seen.set(heldKey(pick), t);
    }
    expect(drawn).toEqual(["8", "10", "8", "10", "8", "10"]);
    // The point, stated as the invariant rather than as the sequence: never
    // the same work twice running.
    for (let i = 1; i < drawn.length; i++) {
      expect(drawn[i]).not.toBe(drawn[i - 1]);
    }
  });

  it("never runs a work twice in a row across a three-work pool", () => {
    const pool = [o("8"), o("10"), o("13")];
    const seen = new Map<string, number>();
    let prev: string | null = null;
    for (let t = 1; t <= 12; t++) {
      // Index 0 of the narrowed list stands in for the seed's choice; what is
      // being asserted is that the LIST never contains last turn's pick.
      const narrowed = leastRecentlyOffered(pool, seen);
      expect(narrowed.some((x) => x.masterId === prev)).toBe(false);
      const pick = narrowed[0]!;
      expect(pick.masterId).not.toBe(prev);
      prev = pick.masterId;
      seen.set(heldKey(pick), t);
    }
  });

  // Ties stay in, so a wide catalogue of unseen works is still a uniform draw
  // and not an alphabetical march.
  it("keeps every tie so the seed still decides", () => {
    const pool = [o("8"), o("10"), o("13")];
    expect(leastRecentlyOffered(pool, new Map()).length).toBe(3);
    const seen = new Map([
      [heldKey(o("8")), 5],
      [heldKey(o("10")), 5],
      [heldKey(o("13")), 9],
    ]);
    expect(ids(leastRecentlyOffered(pool, seen))).toEqual(["10", "8"]);
  });

  // Narrowing, never excluding: an empty result would be reported to the
  // player as catalogue_exhausted, which would be a lie.
  it("returns something whenever it is given something", () => {
    const pool = [o("8")];
    const seen = new Map([[heldKey(o("8")), 1]]);
    expect(leastRecentlyOffered(pool, seen)).toHaveLength(1);
    expect(leastRecentlyOffered([], seen)).toHaveLength(0);
  });

  // Tier is part of the key, so the collector edition of a work just shown is
  // still a repeat of that work's STANDARD only if the key says so — it does
  // not, and that is deliberate: they are two products at two prices.
  it("treats the two tiers of one master as different works", () => {
    const seen = new Map([[heldKey(o("8", "STANDARD")), 1]]);
    expect(
      ids(
        leastRecentlyOffered([o("8", "STANDARD"), o("8", "COLLECTOR")], seen),
      ),
    ).toEqual(["8"]);
    expect(
      leastRecentlyOffered([o("8", "STANDARD"), o("8", "COLLECTOR")], seen)[0]!
        .tier,
    ).toBe("COLLECTOR");
  });

  it("feeds deriveEdition without emptying it", () => {
    const pool = [o("8"), o("10")];
    const seen = new Map([[heldKey(o("8")), 1]]);
    const draw = deriveEdition("seed", {
      catalogue: leastRecentlyOffered(pool, seen),
    });
    expect(draw.offer.masterId).toBe("10");
  });
});

describe("placeableFor without the affordability filter", () => {
  const o = (
    masterId: string,
    priceWei: bigint | null,
    terms: "FREE" | "PURCHASE" = "PURCHASE",
  ): EditionOffer => ({
    collection: "0xreg",
    masterId,
    kind: "MUSIC",
    tier: "STANDARD",
    terms,
    priceWei,
  });
  const MON = 10n ** 18n;
  const GAS = MON / 20n; // 0.05
  const ids = (xs: readonly EditionOffer[]) => xs.map((x) => x.masterId).sort();

  // The live numbers on 2026-09-21: a 24.45 MON wallet against a catalogue
  // whose cheapest unheld offer is 35. The filter turned seven works into
  // catalogue_exhausted — no card at all.
  const CATALOGUE = [
    o("13", (8n * MON) / 10n),
    o("10", 35n * MON),
    o("8", 35n * MON),
    o("9", 100n * MON),
    o("12", 300n * MON),
  ];
  const WALLET = 24_450_000_000_000_000_000n; // 24.45 MON

  it("empties the pool with the filter on, which is the bug", () => {
    const held = new Set([heldKey(o("13", null))]);
    expect(placeableFor(CATALOGUE, held, WALLET, GAS)).toHaveLength(0);
  });

  it("offers everything unheld with the filter off", () => {
    const held = new Set([heldKey(o("13", null))]);
    expect(
      ids(
        placeableFor(CATALOGUE, held, WALLET, GAS, {
          requireAffordable: false,
        }),
      ),
    ).toEqual(["10", "12", "8", "9"]);
  });

  // THE POINT OF THE CLARIFICATION: "any NFT they have not purchased yet".
  // Ownership is never waived, at either setting.
  it("never offers a work they already hold, filter on or off", () => {
    const held = new Set([
      heldKey(o("13", null)),
      heldKey(o("10", null)),
      heldKey(o("8", null)),
    ]);
    for (const requireAffordable of [true, false]) {
      const out = placeableFor(CATALOGUE, held, WALLET, GAS, {
        requireAffordable,
      });
      expect(out.some((x) => ["13", "10", "8"].includes(x.masterId))).toBe(
        false,
      );
    }
  });

  it("still offers a FREE work to an empty wallet", () => {
    const cat = [o("7", null, "FREE")];
    expect(placeableFor(cat, new Set(), 0n, GAS)).toHaveLength(1);
    expect(
      placeableFor(cat, new Set(), 0n, GAS, { requireAffordable: false }),
    ).toHaveLength(1);
  });

  // Not a blanket yes: a PURCHASE with no usable price must never reach a
  // hunter, whatever the flag says. Reject by default survives the change.
  it("still refuses a PURCHASE with no usable price", () => {
    for (const bad of [o("99", null), o("99", 0n)]) {
      expect(() =>
        placeableFor([bad], new Set(), WALLET, GAS, {
          requireAffordable: false,
        }),
      ).toThrow(RangeError);
    }
  });

  it("defaults to filtering, so an existing hunt is unchanged", () => {
    expect(placeableFor(CATALOGUE, new Set(), WALLET, GAS)).toEqual(
      placeableFor(CATALOGUE, new Set(), WALLET, GAS, {
        requireAffordable: true,
      }),
    );
    expect(ids(placeableFor(CATALOGUE, new Set(), WALLET, GAS))).toEqual([
      "13",
    ]);
  });
});
