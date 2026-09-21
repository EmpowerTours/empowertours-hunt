import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectorEntry,
  parseCatalogue,
  readCatalogue,
  resetCatalogueCache,
  toEntry,
} from "./catalogue";

/* ---------------------------------------------------------------------------
   The fixture is a real response, trimmed.

   Captured from music.empowertours.xyz/api/catalogue on 2026-09-20. Using the
   venue's actual field names and value shapes — price as a decimal STRING in
   wei, tokenId as a string, isArt as a boolean — is the point: a hand-invented
   fixture would agree with whatever this parser happens to do.
--------------------------------------------------------------------------- */

const REG = "0x42EbcD44C2295702130f0A641633c691bA5f9480";

const LIVE_BODY = {
  success: true,
  source: "chain",
  reason: "read from the contracts",
  tracks: [
    {
      id: "music-143-12",
      tokenId: "12",
      price: "300000000000000000000",
      isArt: false,
      name: "Suddenly",
      imageUrl: "https://gw/ipfs/QmImage",
      previewUrl: "https://gw/ipfs/QmPreview",
      tokenURI: "ipfs://QmXeAs",
    },
    {
      id: "music-143-10",
      tokenId: "10",
      price: "35000000000000000000",
      isArt: false,
      name: "Sloppy",
      imageUrl: "https://gw/ipfs/QmImage2",
      previewUrl: null,
    },
  ],
};

afterEach(() => {
  resetCatalogueCache();
  vi.unstubAllGlobals();
});

describe("toEntry", () => {
  it("maps a real track to a STANDARD purchase offer", () => {
    expect(toEntry(LIVE_BODY.tracks[0]!, REG)).toEqual({
      collection: REG,
      masterId: "12",
      kind: "MUSIC",
      tier: "STANDARD",
      terms: "PURCHASE",
      priceWei: 300_000_000_000_000_000_000n,
      name: "Suddenly",
      imageUrl: "https://gw/ipfs/QmImage",
      previewUrl: "https://gw/ipfs/QmPreview",
    });
  });

  it("marks art by the isArt flag", () => {
    const e = toEntry({ tokenId: "1", price: "5", isArt: true }, REG);
    expect(e?.kind).toBe("ART");
  });

  // A zero price would become a PURCHASE the venue then refuses with
  // ZeroPrice, so the hunter would walk to a card that cannot complete.
  it("skips a track priced at zero rather than offering it", () => {
    expect(toEntry({ tokenId: "1", price: "0" }, REG)).toBeNull();
  });

  it("skips a track with no id or no price", () => {
    expect(toEntry({ price: "5" }, REG)).toBeNull();
    expect(toEntry({ tokenId: "1" }, REG)).toBeNull();
  });

  it("skips a price that is not a number rather than defaulting it", () => {
    expect(toEntry({ tokenId: "1", price: "abc" }, REG)).toBeNull();
  });

  it("falls back to the id when a track has no name", () => {
    expect(toEntry({ tokenId: "7", price: "5" }, REG)?.name).toBe("#7");
  });
});

describe("parseCatalogue", () => {
  it("parses the live shape", () => {
    const out = parseCatalogue(LIVE_BODY, REG);
    expect(out?.map((e) => e.masterId)).toEqual(["12", "10"]);
  });

  it("drops bad tracks but keeps the good ones", () => {
    const out = parseCatalogue(
      { tracks: [{ tokenId: "1", price: "0" }, LIVE_BODY.tracks[1]] },
      REG,
    );
    expect(out?.map((e) => e.masterId)).toEqual(["10"]);
  });

  // Null means "could not read", which is not the same as an empty list.
  it("returns null for a body that is not a catalogue", () => {
    expect(parseCatalogue({ oops: true }, REG)).toBeNull();
    expect(parseCatalogue("nope", REG)).toBeNull();
    expect(parseCatalogue(null, REG)).toBeNull();
  });

  it("returns an empty list for a real but empty catalogue", () => {
    expect(parseCatalogue({ tracks: [] }, REG)).toEqual([]);
  });
});

describe("readCatalogue", () => {
  const OPTS = { url: "https://venue.test/api/catalogue", collection: REG };

  function stubFetch(impl: () => Promise<Response>) {
    const spy = vi.fn(impl);
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  const okResponse = () =>
    Promise.resolve(new Response(JSON.stringify(LIVE_BODY), { status: 200 }));

  it("reads and maps the catalogue", async () => {
    stubFetch(okResponse);
    const r = await readCatalogue(OPTS);
    expect(r.ok && r.entries.map((e) => e.masterId)).toEqual(["12", "10"]);
  });

  it("serves the cache instead of asking again", async () => {
    const spy = stubFetch(okResponse);
    await readCatalogue({ ...OPTS, now: 1000 });
    await readCatalogue({ ...OPTS, now: 2000 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("asks again once the cache is stale", async () => {
    const spy = stubFetch(okResponse);
    await readCatalogue({ ...OPTS, now: 0, ttlMs: 100 });
    await readCatalogue({ ...OPTS, now: 500, ttlMs: 100 });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  // Placement runs per player. Without single-flight a busy hunt would put one
  // request per scan onto somebody else's service.
  it("collapses concurrent callers into one request", async () => {
    const spy = stubFetch(okResponse);
    await Promise.all([
      readCatalogue(OPTS),
      readCatalogue(OPTS),
      readCatalogue(OPTS),
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("reports unavailable on a non-200", async () => {
    stubFetch(() => Promise.resolve(new Response("nope", { status: 503 })));
    expect(await readCatalogue(OPTS)).toEqual({
      ok: false,
      reason: "catalogue_unavailable",
    });
  });

  it("reports unavailable when the request throws", async () => {
    stubFetch(() => Promise.reject(new Error("dns")));
    expect(await readCatalogue(OPTS)).toEqual({
      ok: false,
      reason: "catalogue_unavailable",
    });
  });

  // A failure cached for five minutes would turn one blip into an outage.
  it("never caches a failure", async () => {
    const spy = vi.fn();
    spy.mockRejectedValueOnce(new Error("dns")).mockImplementation(okResponse);
    vi.stubGlobal("fetch", spy);
    expect((await readCatalogue(OPTS)).ok).toBe(false);
    expect((await readCatalogue(OPTS)).ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("treats an unconfigured deployment as unavailable, not empty", async () => {
    const spy = stubFetch(okResponse);
    expect(await readCatalogue({ url: undefined, collection: REG })).toEqual({
      ok: false,
      reason: "catalogue_unavailable",
    });
    expect(spy).not.toHaveBeenCalled();
  });
});

/* ---------------------------------------------------------------------------
   The collector tier.

   Hunt placed only the standard licence until 2026-09-21, because collector
   prices are deliberately enormous — Killah's is 1,000,000 WMON — and a card
   nobody could act on is noise. That reason stopped holding once placeableFor
   started filtering by what the hunter can pay: the affordability filter makes
   an unreachable card unreachable, and excluding the tier only denied a funded
   hunter the one card they might have wanted.

   So these check the two things the catalogue is still responsible for: a real
   price, and remaining supply.
--------------------------------------------------------------------------- */

/** Dime Que Sí as the venue reports it: 0.8 standard, 500 collector, 100 left. */
const DUAL_TIER = {
  id: "music-143-13",
  tokenId: "13",
  price: "800000000000000000",
  collectorPrice: "500000000000000000000",
  collectorsRemaining: 100,
  isArt: false,
  name: "Dime Que Si",
  imageUrl: "https://gw/ipfs/QmCover",
  previewUrl: "https://gw/ipfs/QmClip",
};

describe("collectorEntry", () => {
  it("offers the collector tier when it is priced and has supply", () => {
    const e = collectorEntry(DUAL_TIER, REG)!;
    expect(e.tier).toBe("COLLECTOR");
    expect(e.priceWei).toBe(500_000_000_000_000_000_000n);
    expect(e.masterId).toBe("13");
  });

  it("carries the same name and artwork as the standard tier", () => {
    // Two offers for one work; a card for either must draw the same record.
    const std = toEntry(DUAL_TIER, REG)!;
    const col = collectorEntry(DUAL_TIER, REG)!;
    expect(col.name).toBe(std.name);
    expect(col.imageUrl).toBe(std.imageUrl);
    expect(col.previewUrl).toBe(std.previewUrl);
    expect(col.kind).toBe(std.kind);
  });

  it("offers nothing when the venue does not send the field at all", () => {
    // An older venue deployment. This is what makes the rollout safe: the
    // catalogue behaves exactly as it did before the field existed.
    const { collectorPrice, collectorsRemaining, ...older } = DUAL_TIER;
    void collectorPrice;
    void collectorsRemaining;
    expect(collectorEntry(older, REG)).toBeNull();
  });

  it("treats a zero collector price as no tier, not as free", () => {
    // The venue reverts on a zero price, so it is unbuyable either way.
    expect(
      collectorEntry({ ...DUAL_TIER, collectorPrice: "0" }, REG),
    ).toBeNull();
  });

  it("refuses a sold-out tier even though it is still priced", () => {
    // purchase() reverts past maxCollectorEditions, and Monad charges the full
    // gas limit on a revert — an offered card that cannot complete costs the
    // hunter real MON to find out.
    expect(
      collectorEntry({ ...DUAL_TIER, collectorsRemaining: 0 }, REG),
    ).toBeNull();
  });

  it("counts a missing or malformed supply as sold out", () => {
    for (const bad of [undefined, null, "100", -1, Number.NaN]) {
      expect(
        collectorEntry({ ...DUAL_TIER, collectorsRemaining: bad }, REG),
      ).toBeNull();
    }
  });

  it("offers nothing when the work itself is not offerable", () => {
    // No usable standard entry means no id or no price — neither tier stands.
    expect(collectorEntry({ ...DUAL_TIER, tokenId: undefined }, REG)).toBeNull();
  });

  it("DOES offer a 1,000,000 WMON collector edition", () => {
    // Deliberate. The catalogue's job is not to guess who can afford what —
    // placeableFor filters on the hunter's actual balance before the draw, so
    // excluding this here would only deny a funded hunter a card they could
    // have taken.
    const killah = {
      ...DUAL_TIER,
      tokenId: "9",
      collectorPrice: "1000000000000000000000000",
      collectorsRemaining: 5,
    };
    expect(collectorEntry(killah, REG)!.priceWei).toBe(
      1_000_000_000_000_000_000_000_000n,
    );
  });
});

describe("parseCatalogue — two tiers", () => {
  it("emits both offers for one dual-tier track", () => {
    const out = parseCatalogue({ tracks: [DUAL_TIER] }, REG)!;
    expect(out.map((e) => e.tier).sort()).toEqual(["COLLECTOR", "STANDARD"]);
    expect(new Set(out.map((e) => e.masterId))).toEqual(new Set(["13"]));
  });

  it("still emits one offer for a standard-only track", () => {
    const out = parseCatalogue(LIVE_BODY, REG)!;
    expect(out).toHaveLength(2); // two tracks, neither with a collector tier
    expect(out.every((e) => e.tier === "STANDARD")).toBe(true);
  });
});
