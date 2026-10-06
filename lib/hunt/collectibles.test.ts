import { describe, expect, it } from "vitest";
import {
  COLLECTIONS,
  addressTopic,
  readMetadata,
  toHttpUrl,
  tokenIdsFromLogs,
} from "./collectibles";

const T = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (n: number) => "0x" + n.toString(16).padStart(64, "0");

describe("tokenIdsFromLogs", () => {
  it("reads the tokenId out of a 4-topic ERC-721 Transfer", () => {
    expect(
      tokenIdsFromLogs([{ topics: [T, pad(0), pad(1), pad(936)] }]),
    ).toEqual([936n]);
  });

  it("IGNORES a 3-topic Transfer, which is ERC-20", () => {
    // Same event signature, no indexed tokenId. Reading topics[3] off one of
    // these yields undefined; reading the amount as a tokenId would invent a
    // token. The wallet this was built for holds both kinds.
    expect(tokenIdsFromLogs([{ topics: [T, pad(0), pad(1)] }])).toEqual([]);
  });

  it("de-duplicates a token that arrived, left and came back", () => {
    expect(
      tokenIdsFromLogs([
        { topics: [T, pad(0), pad(1), pad(7)] },
        { topics: [T, pad(2), pad(1), pad(7)] },
        { topics: [T, pad(0), pad(1), pad(8)] },
      ]),
    ).toEqual([7n, 8n]);
  });

  it("skips a malformed topic rather than throwing the whole scan away", () => {
    expect(
      tokenIdsFromLogs([
        { topics: [T, pad(0), pad(1), "not-hex"] },
        { topics: [T, pad(0), pad(1), pad(5)] },
      ]),
    ).toEqual([5n]);
  });
});

describe("toHttpUrl", () => {
  it("sends ipfs through a gateway, because an img tag cannot load ipfs://", () => {
    // MetaMask will not resolve ipfs:// on Monad and neither will the browser.
    expect(toHttpUrl("ipfs://bafyabc/1.png")).toBe(
      "https://ipfs.io/ipfs/bafyabc/1.png",
    );
    expect(toHttpUrl("ipfs://ipfs/bafyabc")).toBe(
      "https://ipfs.io/ipfs/bafyabc",
    );
  });

  it("passes https straight through", () => {
    // r3tards serves https already.
    const u = "https://www.scatter.art/api/instareveal/abc/936";
    expect(toHttpUrl(u)).toBe(u);
  });

  it("handles arweave and data URIs", () => {
    expect(toHttpUrl("ar://xyz")).toBe("https://arweave.net/xyz");
    expect(toHttpUrl("data:image/svg+xml;base64,AAA")).toBe(
      "data:image/svg+xml;base64,AAA",
    );
  });

  it("returns null rather than guessing at a bare CID or empty value", () => {
    expect(toHttpUrl("bafybeiabc")).toBeNull();
    expect(toHttpUrl("")).toBeNull();
    expect(toHttpUrl(null)).toBeNull();
    expect(toHttpUrl(undefined)).toBeNull();
  });
});

describe("readMetadata", () => {
  it("reads name and image, including the image_url spelling", () => {
    expect(
      readMetadata({ name: "r3tards #936", image: "ipfs://a/b.png" }),
    ).toEqual({ name: "r3tards #936", image: "https://ipfs.io/ipfs/a/b.png" });
    expect(readMetadata({ image_url: "https://x/y.png" }).image).toBe(
      "https://x/y.png",
    );
  });

  it("survives anything that is not an object", () => {
    for (const junk of [null, undefined, "", 7, [], "a string"]) {
      expect(readMetadata(junk)).toEqual({ name: null, image: null });
    }
  });

  it("treats a blank name as absent", () => {
    expect(readMetadata({ name: "   " }).name).toBeNull();
  });
});

describe("addressTopic", () => {
  it("left-pads an address to 32 bytes, lowercased", () => {
    expect(addressTopic("0xA80C90d2b02433fa0071ef6301e92bffcec90d13")).toBe(
      "0x000000000000000000000000a80c90d2b02433fa0071ef6301e92bffcec90d13",
    );
  });

  it("refuses something that is not an address", () => {
    expect(() => addressTopic("0x1234")).toThrow();
  });
});

describe("the collection list", () => {
  it("holds r3tards at its verified mainnet address", () => {
    // Confirmed on Monad 2026-10-06: name() "r3tards", symbol() "R3TARDS",
    // ownerOf(936) is the hunter's passkey wallet.
    const r3 = COLLECTIONS.find((c) => c.name === "r3tards");
    expect(r3?.address).toBe("0x200723a706de0013316e5cd8eba2b3f53dd90c29");
  });

  it("gives every collection a positive start block", () => {
    // fromBlock 0 would scan the chain from genesis on every page load.
    for (const c of COLLECTIONS) expect(c.fromBlock).toBeGreaterThan(0n);
  });
});
