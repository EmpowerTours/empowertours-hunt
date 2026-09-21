import { describe, expect, it } from "vitest";
import {
  KURU_MON_USDC_MARKET,
  UNISWAP_V4_POOL_MANAGER,
  parseQuote,
  usesOrderBook,
} from "./kuru";

// ---------------------------------------------------------------------------
// The claim this integration makes is "the trade executes on Kuru's order
// book". That claim is only worth anything if something checks it.
//
// Kuru's aggregator picks a path per quote. Nothing stops it routing MON->USDC
// through an AMM tomorrow, and if it did, every number would still look right
// while the claim quietly became false. So `usesOrderBook` reads the calldata
// we are about to sign, and these tests pin it from BOTH sides: a real
// order-book route is recognised, and a real AMM route is NOT.
//
// The two payloads below are shaped from actual mainnet quotes taken
// 2026-09-19: MON->USDC carried the market address and no v4 manager; USDC->AUSD
// carried the v4 manager and no market.
// ---------------------------------------------------------------------------

const MARKET = KURU_MON_USDC_MARKET.slice(2);
const V4 = UNISWAP_V4_POOL_MANAGER.slice(2);

/** A quote body in the shape Kuru actually returns. */
function body(calldata: string, output = "493140", minOut = "491907") {
  return {
    output,
    minOut,
    transaction: {
      to: "0xb3e6778480b2E488385E8205eA05E20060B813cb",
      value: "20000000000000000000",
      data: calldata,
    },
  };
}

describe("usesOrderBook", () => {
  it("recognises the MON/USDC order book in the path", () => {
    expect(usesOrderBook(`0xabcdef${MARKET}0000`)).toBe(true);
  });

  it("does NOT claim the book for a Uniswap v4 route", () => {
    // This is the failing case that matters. USDC->AUSD really does go through
    // v4, and calling that "on Kuru's order book" would be a false claim in a
    // bounty submission.
    expect(usesOrderBook(`0xabcdef${V4}0000`)).toBe(false);
  });

  it("is case-insensitive — Kuru returns mixed case, chains return lower", () => {
    expect(usesOrderBook(`0xAB${MARKET.toUpperCase()}CD`)).toBe(true);
  });

  it("does not match a near-miss address", () => {
    const wrong = MARKET.slice(0, -1) + (MARKET.slice(-1) === "4" ? "5" : "4");
    expect(usesOrderBook(`0x${wrong}`)).toBe(false);
  });
});

describe("parseQuote — the 0x prefix", () => {
  it("adds the prefix Kuru omits from calldata", () => {
    // Kuru returns `to` WITH 0x and `data` WITHOUT it. Verified against the
    // live API. Passing the raw string to viem sends different bytes than Kuru
    // built and the transaction reverts with EMPTY revert data — at any gas
    // limit, against any block — which resembles every cause except the real
    // one. This cost a live 5 MON trade.
    const q = parseQuote({
      output: "124676",
      minOut: "123429",
      transaction: {
        to: "0xb3e6778480b2E488385E8205eA05E20060B813cb",
        value: "5000000000000000000",
        data: `ce1e7030${MARKET}`,
      },
    });
    expect(q.calldata.startsWith("0x")).toBe(true);
    expect(q.calldata).toBe(`0xce1e7030${MARKET}`);
  });

  it("does not double-prefix one that already has it", () => {
    const q = parseQuote({
      output: "1",
      minOut: "1",
      transaction: { to: "0xabc", value: "0", data: `0xce1e7030${MARKET}` },
    });
    expect(q.calldata).toBe(`0xce1e7030${MARKET}`);
    expect(q.calldata.startsWith("0x0x")).toBe(false);
  });

  it("normalises `to` as well, since the schema promises nothing", () => {
    const q = parseQuote({
      output: "1",
      minOut: "1",
      transaction: { to: "B3E6778480B2E488385E8205EA05E20060B813CB", value: "0", data: "0xab" },
    });
    expect(q.to).toBe("0xb3e6778480b2e488385e8205ea05e20060b813cb");
  });
});

describe("parseQuote", () => {
  it("reads the numbers as bigint and reports the venue", () => {
    const q = parseQuote(body(`0x00${MARKET}ff`));
    expect(q.output).toBe(493140n);
    expect(q.minOut).toBe(491907n);
    expect(q.value).toBe(20000000000000000000n);
    expect(q.usesOrderBook).toBe(true);
  });

  it("accepts `calldata` as well as `data` — the API has used both names", () => {
    const b = {
      output: "1",
      minOut: "1",
      transaction: { to: "0xabc", value: "0", calldata: `0x${MARKET}` },
    };
    expect(parseQuote(b).usesOrderBook).toBe(true);
  });

  it("defaults a missing value to zero rather than NaN", () => {
    const b = {
      output: "10000797",
      minOut: "9990000",
      transaction: { to: "0xabc", data: "0xdead" },
    };
    expect(parseQuote(b).value).toBe(0n);
  });

  it("throws on a malformed response instead of handing undefined onward", () => {
    expect(() => parseQuote({ output: "1" })).toThrow(/missing/i);
    expect(() => parseQuote({})).toThrow(/missing/i);
    // A number where a decimal string belongs: JSON.parse would silently lose
    // precision on a uint256, so the API sends strings and so do we.
    expect(() =>
      parseQuote({
        output: 1,
        minOut: "1",
        transaction: { to: "0x", data: "0x" },
      }),
    ).toThrow(/missing/i);
  });

  it("lowercases calldata so the venue check cannot miss on casing", () => {
    const q = parseQuote(body(`0xAA${MARKET.toUpperCase()}`));
    expect(q.calldata).toBe(q.calldata.toLowerCase());
    expect(q.usesOrderBook).toBe(true);
  });
});
