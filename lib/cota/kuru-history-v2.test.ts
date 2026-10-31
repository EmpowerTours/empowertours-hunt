import { describe, expect, it } from "vitest";
import { encodeFunctionData, type Hex } from "viem";
import { swapResultFromOutput, toRecordV2, type ChainTx } from "./kuru-history-v2";
import { NotAKuruTrade } from "./kuru-history";
import { ACCOUNT_CORE_ABI, KURU_ACCOUNT_CORE, KURU_MON_USDC, NATIVE_MON } from "./kuru-v2";
import { USDC } from "./kuru";

const W = "0xe2ab465839e409c80d1ca4bb4508fea7eb808395";
const OTHER = "0x7d5be2896c49faea8746eea8b8585b46210e6853";

// Captured verbatim from an eth_simulateV1 run of the hunter's 843 MON sale on
// mainnet state, 2026-10-31: the swap's calldata and its return value.
const SELL_INPUT =
  "0x9d49a2c50000000000000000000000000000000000000000000000000000000000000113000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002db2f9a198364c00000000000000000000000000000000000000000000000000000000000000fb26ab000000000000000000000000000000000000000000000000000000006ae54908" as Hex;
const SELL_OUTPUT =
  "0x00000000000000000000000000000000000000000000002db2f9a198364c00000000000000000000000000000000000000000000000000000000000000fdb01c" as Hex;
// And a 5 USDC buy's return value from the same kind of run.
const BUY_OUTPUT =
  "0x00000000000000000000000000000000000000000000000000000000004c4b4000000000000000000000000000000000000000000000000dae8d7d7d85435200" as Hex;

const receipt = (over: Partial<ChainTx["receipt"]> = {}): ChainTx["receipt"] => ({
  status: "success",
  from: W,
  to: KURU_MON_USDC,
  blockNumber: 100n,
  gasUsed: 583_515n,
  effectiveGasPrice: 102_000_000_000n,
  ...over,
});
const swapTx = (input: Hex, over: Partial<ChainTx["receipt"]> = {}): ChainTx => ({
  receipt: receipt(over),
  input,
});
const acctTx = (fn: "deposit" | "withdraw", args: readonly unknown[], gas = 500_000n): ChainTx => ({
  receipt: receipt({ to: KURU_ACCOUNT_CORE, gasUsed: gas }),
  input: encodeFunctionData({ abi: ACCOUNT_CORE_ABI, functionName: fn, args } as never),
});

describe("swapResultFromOutput", () => {
  it("decodes the real sell: 843 MON in, 16.625692 USDC out", () => {
    expect(swapResultFromOutput(SELL_OUTPUT)).toEqual({
      amountInUsed: 843n * 10n ** 18n,
      amountOut: 16_625_692n,
    });
  });
  it("decodes the real buy: 5 USDC in, 252.385… MON out", () => {
    expect(swapResultFromOutput(BUY_OUTPUT)).toEqual({
      amountInUsed: 5_000_000n,
      amountOut: 252_385_520_270_600_000_000n,
    });
  });
  it("is null, not zero, when there is no output", () => {
    expect(swapResultFromOutput(null)).toBeNull();
    expect(swapResultFromOutput("0x")).toBeNull();
  });
});

describe("toRecordV2 — a sell", () => {
  it("reads the same shape the leaderboard already counts", () => {
    const r = toRecordV2({
      hash: "0xABC",
      side: "sell",
      swap: swapTx(SELL_INPUT),
      swapOutput: SELL_OUTPUT,
    });
    expect(r).toMatchObject({
      hash: "0xabc",
      wallet: W,
      ok: true,
      valueWei: 843n * 10n ** 18n,
      tokensIn: { [USDC.toLowerCase()]: 16_625_692n },
      tokensOut: {},
      nativeInWei: 0n,
      crossedOrderBook: true,
    });
  });

  it("charges the gas of all three transactions, not only the swap", () => {
    const r = toRecordV2({
      hash: "0xabc",
      side: "sell",
      swap: swapTx(SELL_INPUT),
      swapOutput: SELL_OUTPUT,
      deposit: acctTx("deposit", [W, NATIVE_MON, 843n * 10n ** 18n], 592_000n),
      withdraw: acctTx("withdraw", [275, USDC, 16_625_692n, W], 529_000n),
    });
    expect(r.gasWei).toBe((592_000n + 583_515n + 529_000n) * 102_000_000_000n);
  });

  it("leaves USDC received unknown, not zero, without a trace", () => {
    const r = toRecordV2({ hash: "0xabc", side: "sell", swap: swapTx(SELL_INPUT), swapOutput: null });
    expect(r.valueWei).toBe(843n * 10n ** 18n);
    expect(r.tokensIn).toEqual({});
  });

  it("records a reverted swap as moving nothing — and keeps it", () => {
    const r = toRecordV2({
      hash: "0xabc",
      side: "sell",
      swap: swapTx(SELL_INPUT, { status: "reverted" }),
      swapOutput: null,
    });
    expect(r).toMatchObject({ ok: false, valueWei: 0n, nativeInWei: 0n, crossedOrderBook: false });
  });
});

describe("toRecordV2 — refusing what is not this trade", () => {
  it("a transaction to anything but the MON/USDC book", () => {
    expect(() =>
      toRecordV2({ hash: "0x1", side: "sell", swap: swapTx(SELL_INPUT, { to: OTHER }), swapOutput: null }),
    ).toThrow(NotAKuruTrade);
  });
  it("a sell posted as a buy", () => {
    expect(() =>
      toRecordV2({ hash: "0x1", side: "buy", swap: swapTx(SELL_INPUT), swapOutput: null }),
    ).toThrow(/was a sell/);
  });
  it("a withdrawal paid to someone else", () => {
    expect(() =>
      toRecordV2({
        hash: "0x1",
        side: "sell",
        swap: swapTx(SELL_INPUT),
        swapOutput: null,
        withdraw: acctTx("withdraw", [275, USDC, 1n, OTHER]),
      }),
    ).toThrow(/different wallet/);
  });
  it("a deposit that credited someone else", () => {
    expect(() =>
      toRecordV2({
        hash: "0x1",
        side: "sell",
        swap: swapTx(SELL_INPUT),
        swapOutput: null,
        deposit: acctTx("deposit", [OTHER, NATIVE_MON, 1n]),
      }),
    ).toThrow(/different wallet/);
  });
});
