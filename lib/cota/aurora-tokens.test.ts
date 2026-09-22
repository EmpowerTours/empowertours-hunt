import { describe, expect, it, vi } from "vitest";
import {
  evmChains,
  evmDepositOptions,
  fetchSupportedTokens,
  parseSupportedTokens,
} from "./aurora-tokens";

// ---------------------------------------------------------------------------
// These tests guard a money-loss path, not a render. An asset shown here that
// Aurora does not accept is a hunter's deposit stranded with no refund — the
// address carries no refundTo, so nothing knows where to send it back.
//
// The fixture is the real response shape, read from the live endpoint
// 2026-09-22: `result.in`, 153 entries, `assetId` / `symbol` / `blockchain` /
// `contractAddress` / `decimals`.
// ---------------------------------------------------------------------------

const LIVE = {
  result: {
    in: [
      {
        assetId:
          "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
        symbol: "USDC",
        blockchain: "base",
        contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        decimals: 6,
      },
      {
        assetId: "nep141:base.omft.near",
        symbol: "ETH",
        blockchain: "base",
        contractAddress: "",
        decimals: 18,
      },
      {
        assetId: "nep141:eth-0xa0b8.omft.near",
        symbol: "USDC",
        blockchain: "eth",
        contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        decimals: 6,
      },
      {
        assetId: "nep141:sol-abc.omft.near",
        symbol: "USDC",
        blockchain: "sol",
        contractAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        decimals: 6,
      },
      {
        assetId: "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx",
        symbol: "USDC",
        blockchain: "monad",
        contractAddress: "0x754704bc059f8c67012fed69bc8a327a5aafb603",
        decimals: 6,
      },
    ],
  },
};

describe("which chains can reach an evm deposit address", () => {
  it("includes chains whose tokens carry 0x addresses", () => {
    expect(evmChains(parseSupportedTokens(LIVE))).toContain("base");
    expect(evmChains(parseSupportedTokens(LIVE))).toContain("eth");
  });

  it("excludes Solana, whose addresses are a different shape entirely", () => {
    // The test that matters: an `evm` address cannot receive a Solana transfer,
    // and listing SOL as an option would invite an unrecoverable deposit.
    expect(evmChains(parseSupportedTokens(LIVE))).not.toContain("sol");
  });

  it("judges a chain by any token on it, since native coins have no contract", () => {
    // Base appears twice: USDC with an address, ETH without. The native coin
    // must not disqualify the chain.
    const options = evmDepositOptions(parseSupportedTokens(LIVE));
    const base = options.find((o) => o.chain === "base");
    expect(base?.symbols).toEqual(["ETH", "USDC"]);
  });
});

describe("what the funding screen offers", () => {
  it("drops Monad, because depositing to the chain you are on is a circle", () => {
    const chains = evmDepositOptions(parseSupportedTokens(LIVE)).map(
      (o) => o.chain,
    );
    expect(chains).not.toContain("monad");
    expect(chains).toContain("base");
  });

  it("hides a token Aurora has marked deprecated", () => {
    // This list is read as instructions for where to send money.
    const rows = parseSupportedTokens({
      result: {
        in: [
          {
            assetId: "a",
            symbol: "USDT0(DEPRECATED)",
            blockchain: "plasma",
            contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
            decimals: 6,
          },
          {
            assetId: "b",
            symbol: "USDT0",
            blockchain: "plasma",
            contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02914",
            decimals: 6,
          },
        ],
      },
    });
    expect(evmDepositOptions(rows)[0]!.symbols).toEqual(["USDT0"]);
  });

  it("offers nothing at all rather than a guess when the feed is unreadable", () => {
    // An empty list renders as "we cannot tell you right now". A partial or
    // invented list would be read as permission to send.
    expect(parseSupportedTokens({})).toEqual([]);
    expect(parseSupportedTokens({ result: { in: "no" } })).toEqual([]);
    expect(parseSupportedTokens(null)).toEqual([]);
    expect(evmDepositOptions([])).toEqual([]);
  });

  it("drops a row it cannot name or place", () => {
    const rows = parseSupportedTokens({
      result: {
        in: [
          { symbol: "USDC", contractAddress: "0x1" },
          { blockchain: "base", contractAddress: "0x1" },
          {
            assetId: "a",
            symbol: "OK",
            blockchain: "base",
            contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
            decimals: 6,
          },
        ],
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.symbol).toBe("OK");
  });
});

describe("fetching the list", () => {
  it("asks for the deposit direction and needs no API key", async () => {
    const calls: string[] = [];
    const fake = vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify(LIVE));
    }) as unknown as typeof fetch;
    await fetchSupportedTokens({ fetch: fake });
    expect(calls[0]).toContain("/api/v1/supported_tokens");
    expect(calls[0]).toContain("flow=inOperation");
    // If a key ever appears in this URL, the screen stops working for anyone
    // whose deployment lacks one — and this list must render regardless.
    expect(calls[0]).not.toMatch(/key/i);
  });

  it("throws rather than returning an empty list on an HTTP error", async () => {
    const fake = vi.fn(
      async () => new Response("nope", { status: 500 }),
    ) as unknown as typeof fetch;
    // The difference matters: [] means "Aurora accepts nothing", which is a
    // lie. The caller must be able to tell a failure from an answer.
    await expect(fetchSupportedTokens({ fetch: fake })).rejects.toThrow();
  });
});
