import { afterEach, describe, expect, it, vi } from "vitest";
import {
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
