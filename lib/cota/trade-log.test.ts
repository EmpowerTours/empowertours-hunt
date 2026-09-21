import { describe, expect, it } from "vitest";
import {
  USDC_ADDRESS,
  gasBps,
  gasMon,
  outcomeOf,
  receivedText,
  spentMon,
  type TradeRow,
} from "./trade-log";

// ---------------------------------------------------------------------------
// Built around the first real spot trade, because every interesting case in
// this file is a way of describing it wrongly:
//
//   0x95f14269…2bb0 — 5 MON in, 0.123884 USDC out, SUCCEEDED, gas 0.095229 MON,
//   and it did NOT cross Kuru's order book despite the screen saying so.
// ---------------------------------------------------------------------------

const SELL: TradeRow = {
  hash: "0x95f1426966365e3c78ea7fb5f38339c4b310c753db7205745f62d68e7baf2bb0",
  ok: true,
  side: "sell",
  gasWei: "95229342000000000",
  valueWei: "5000000000000000000",
  tokensIn: { [USDC_ADDRESS]: "123884" },
  crossedOrderBook: false,
  at: "2026-09-20T21:11:27.000Z",
};

describe("outcomeOf", () => {
  it("reads what the real sell delivered", () => {
    const o = outcomeOf(SELL);
    expect(o).toEqual({
      kind: "received",
      units: 123884n,
      decimals: 6,
      symbol: "USDC",
    });
    expect(receivedText(o)).toBe("0.123884 USDC");
  });

  it("does NOT say 'you received 0' on a successful buy", () => {
    // THE CASE THAT MATTERS. Buying MON pays out in the native token, which
    // moves no Transfer event, so the receipt genuinely has no amount in it.
    // Reporting zero would understate every successful buy a hunter ever makes.
    const buy: TradeRow = { ...SELL, side: "buy", valueWei: "0", tokensIn: {} };
    expect(outcomeOf(buy)).toEqual({ kind: "filled-amount-unknown" });
    expect(receivedText(outcomeOf(buy))).toBeNull();
  });

  it("calls a revert a revert, not an empty trade", () => {
    const rev: TradeRow = { ...SELL, ok: false, tokensIn: {} };
    expect(outcomeOf(rev)).toEqual({ kind: "reverted" });
  });

  it("never reports proceeds on a revert, whatever the row claims", () => {
    // Belt and braces: `ok` decides. A reverted transaction emits no logs, so
    // any tokensIn here is nonsense that must not surface as a payout.
    const rev: TradeRow = { ...SELL, ok: false };
    expect(outcomeOf(rev).kind).toBe("reverted");
  });

  it("ignores a zero-unit transfer rather than calling it a fill", () => {
    const zero: TradeRow = { ...SELL, tokensIn: { [USDC_ADDRESS]: "0" } };
    expect(outcomeOf(zero)).toEqual({ kind: "filled-amount-unknown" });
  });

  it("shows raw units for a token whose decimals it does not know", () => {
    // Kuru can route to a token this screen has never heard of. Guessing 18 and
    // printing 0.000000000000000123 would be a fabricated number.
    const odd: TradeRow = { ...SELL, tokensIn: { "0xdead": "123" } };
    expect(receivedText(outcomeOf(odd))).toBe("123");
  });
});

describe("gasMon / spentMon", () => {
  it("reports the real gas, which on Monad is the whole limit", () => {
    expect(gasMon(SELL)).toBe("0.095229");
  });

  it("reports what was sent", () => {
    expect(spentMon(SELL)).toBe("5");
  });

  it("trims trailing zeros instead of printing a wall of them", () => {
    expect(spentMon({ ...SELL, valueWei: "1500000000000000000" })).toBe("1.5");
    expect(spentMon({ ...SELL, valueWei: "0" })).toBe("0");
  });

  it("does not overflow on a trade larger than a 64-bit integer", () => {
    // 10 MON is 1e19, past Number.MAX_SAFE_INTEGER and past Postgres BIGINT.
    // This is why wei is stored and passed as a decimal string throughout.
    expect(spentMon({ ...SELL, valueWei: "10000000000000000000" })).toBe("10");
    expect(spentMon({ ...SELL, valueWei: "123456000000000000000000" })).toBe(
      "123456",
    );
  });
});

describe("gasBps — the number that explains why a trade felt expensive", () => {
  it("prices the real trade honestly", () => {
    // 0.095229 MON of gas on a 5 MON trade. The screen called this a trade on
    // Kuru's tight order book; the gas alone was 190 bps of it.
    expect(gasBps(SELL)).toBeCloseTo(190.46, 1);
  });

  it("falls with size, because gas is FIXED per trade", () => {
    const at = (mon: string) => gasBps({ ...SELL, valueWei: mon })!;
    const five = at("5000000000000000000");
    const fivehundred = at("500000000000000000000");
    expect(fivehundred).toBeLessThan(five / 50);
    expect(fivehundred).toBeCloseTo(1.9, 1);
  });

  it("is null for a buy rather than dividing by zero", () => {
    // A buy spends USDC, so valueWei is 0. A ratio against nothing is not a
    // small number, it is not a number.
    expect(gasBps({ ...SELL, side: "buy", valueWei: "0" })).toBeNull();
  });
});
