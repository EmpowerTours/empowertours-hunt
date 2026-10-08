import { describe, expect, it } from "vitest";
import { parseBlockVisionNfts } from "./blockvision";

// Shape pinned to a REAL mainnet response, 2026-10-08: the hunter who claimed
// r3tards #936 at a Monad Open kiosk.
const REAL = {
  code: 0,
  message: "OK",
  result: {
    data: [
      {
        contractAddress: "0x200723A706de0013316E5cd8EBa2b3f53DD90c29",
        verified: true,
        scamFlag: 0,
        name: "r3tards",
        image: "https://i.ibb.co/xKWvrdbL/pfp-main.png",
        ercStandard: "ERC721",
        items: [
          {
            name: "r3tards #936",
            contractAddress: "0x200723A706de0013316E5cd8EBa2b3f53DD90c29",
            tokenId: "936",
            image: "https://www.scatter.art/api/instareveal/image?x=1",
            qty: "1",
          },
        ],
      },
    ],
    total: 1,
  },
};

describe("parseBlockVisionNfts", () => {
  it("reads the real response", () => {
    expect(parseBlockVisionNfts(REAL)).toEqual([
      {
        collection: "r3tards",
        contract: "0x200723A706de0013316E5cd8EBa2b3f53DD90c29",
        tokenId: "936",
        name: "r3tards #936",
        image: "https://www.scatter.art/api/instareveal/image?x=1",
      },
    ]);
  });

  it("DROPS a collection the indexer flagged as a scam", () => {
    // Anyone can airdrop an NFT to any address. A convincing fake sitting in
    // a wallet that also holds real money is a phishing surface we would be
    // rendering ourselves, and the indexer already knows.
    const scam = structuredClone(REAL) as typeof REAL;
    (scam.result.data[0] as { scamFlag: number }).scamFlag = 1;
    expect(parseBlockVisionNfts(scam)).toEqual([]);
  });

  it("falls back to the collection artwork when a token has no image", () => {
    const d = structuredClone(REAL) as typeof REAL;
    delete (d.result.data[0].items[0] as { image?: string }).image;
    expect(parseBlockVisionNfts(d)[0].image).toBe(
      "https://i.ibb.co/xKWvrdbL/pfp-main.png",
    );
  });

  it("skips a token with no id rather than colliding two rows", () => {
    // tokenId keys the list. Two tokens from one collection without it would
    // render as one.
    const d = structuredClone(REAL) as typeof REAL;
    delete (d.result.data[0].items[0] as { tokenId?: string }).tokenId;
    expect(parseBlockVisionNfts(d)).toEqual([]);
  });

  it("survives anything that is not the shape it expects", () => {
    // Somebody else's API. A change in it must cost the panel, not the page.
    for (const junk of [
      null,
      undefined,
      "",
      7,
      [],
      {},
      { result: null },
      { result: { data: "nope" } },
      { result: { data: [null, 3, "x"] } },
      { result: { data: [{ items: "no" }] } },
    ]) {
      expect(parseBlockVisionNfts(junk)).toEqual([]);
    }
  });

  it("names an unnamed collection rather than showing a blank", () => {
    const d = structuredClone(REAL) as typeof REAL;
    delete (d.result.data[0] as { name?: string }).name;
    expect(parseBlockVisionNfts(d)[0].collection).toBe("Unknown collection");
  });
});

describe("the route prefers the indexer but keeps the scan", () => {
  const SRC = String(
    require("node:fs").readFileSync(
      new URL("../../app/api/hunt/collectibles/route.ts", import.meta.url),
      "utf8",
    ),
  );

  it("uses BlockVision when a key is set", () => {
    expect(SRC).toContain("process.env.BLOCKVISION_API_KEY");
    expect(SRC).toContain("parseBlockVisionNfts");
  });

  it("still falls back to the chain scan", () => {
    // The perk expires. A wallet that empties itself when a key lapses is
    // worse than one showing a named list.
    expect(SRC).toContain("createPublicClient");
    expect(SRC).toContain('source: "chain"');
  });

  it("treats an empty indexer answer as an answer", () => {
    // A hunter with no NFTs is a real result. Falling through to a slower
    // scan that also finds nothing would just be slower.
    expect(SRC).toContain('source: "indexer"');
  });
});
