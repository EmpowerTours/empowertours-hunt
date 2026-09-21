import { describe, expect, it } from "vitest";
import {
  KURU_ENTRYPOINT,
  NotAKuruTrade,
  crossedOrderBook,
  gasChargedWei,
  toRecord,
  tokensReceived,
  type MinimalReceipt,
} from "./kuru-history";
import { KURU_MON_USDC_MARKET } from "./kuru";

// ---------------------------------------------------------------------------
// The fixture is a REAL transaction, not a shape I invented:
// 0x95f1426966365e3c78ea7fb5f38339c4b310c753db7205745f62d68e7baf2bb0, block
// 106,638,665 on Monad mainnet. 5 MON in, 0.123884 USDC out, succeeded, and —
// the part that matters — it went through Uniswap v4 + v3 + v2 and NOT through
// Kuru's order book.
//
// That last fact is why these tests exist. The spot screen says "on Kuru's
// order book" out loud, and a history log that repeats the claim without
// checking would turn one screen's optimism into a permanent record of
// something that did not happen.
// ---------------------------------------------------------------------------

const WALLET = "0xE2ab465839E409C80D1CA4bB4508feA7Eb808395";
const USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603";
const TRANSFER =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const MARKET = KURU_MON_USDC_MARKET;

const pad = (a: string) =>
  `0x${a.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
const transfer = (token: string, from: string, to: string, units: bigint) => ({
  address: token,
  topics: [TRANSFER, pad(from), pad(to)],
  data: `0x${units.toString(16).padStart(64, "0")}`,
});

/** The real receipt, trimmed to the logs these functions read. */
const REAL: MinimalReceipt = {
  status: "success",
  from: WALLET,
  to: KURU_ENTRYPOINT,
  blockNumber: 106_638_665n,
  gasUsed: 933_621n, // == gasLimit. Monad charges the whole limit.
  effectiveGasPrice: 102_000_000_000n,
  logs: [
    // v4 PoolManager swap — the route it really took
    {
      address: "0x188d586ddcf52439676ca21a244753fa19f9ea8e",
      topics: [
        "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f",
        "0xadaf30776f551bccdfb307c3fd8cdec198ca9a852434c8022ee32d1ccedd8219",
        pad("0x2f84fb8982073f39ba47c7fcc29119af074abbcb"),
      ],
      data: "0x00",
    },
    transfer(USDC, KURU_ENTRYPOINT, WALLET, 123_884n),
  ],
};

describe("gasChargedWei — on Monad this is the real cost, not a ceiling", () => {
  it("multiplies the whole limit by the price paid", () => {
    // gasUsed comes back equal to gasLimit because the chain refunds nothing,
    // so there is no "unused gas" to subtract. 0.095229 MON on a $0.12 trade.
    expect(gasChargedWei(REAL)).toBe(95_229_342_000_000_000n);
  });
});

describe("crossedOrderBook — read from the logs, not from hope", () => {
  it("does NOT claim the book for the real pool-routed trade", () => {
    // THE TEST THIS FILE EXISTS FOR. This trade succeeded and the screen was
    // happy; it still never touched Kuru's book.
    expect(crossedOrderBook(REAL.logs)).toBe(false);
  });

  it("finds the market when it emitted a log itself", () => {
    expect(
      crossedOrderBook([{ address: MARKET, topics: [], data: "0x" }]),
    ).toBe(true);
  });

  it("finds the market when it is only named in a topic", () => {
    // Kuru's market is the emitter of some events and a party to others.
    // Checking only `address` misses the second kind.
    expect(
      crossedOrderBook([
        {
          address: USDC,
          topics: [TRANSFER, pad(MARKET), pad(WALLET)],
          data: "0x",
        },
      ]),
    ).toBe(true);
  });

  it("is case-insensitive — chains return lower, Kuru returns mixed", () => {
    expect(
      crossedOrderBook([
        { address: MARKET.toUpperCase(), topics: [], data: "0x" },
      ]),
    ).toBe(true);
  });

  it("says no for an empty log list rather than throwing", () => {
    expect(crossedOrderBook([])).toBe(false);
  });
});

describe("tokensReceived", () => {
  it("reads what actually reached the wallet", () => {
    expect(tokensReceived(REAL.logs, WALLET)).toEqual({ [USDC]: 123_884n });
  });

  it("sums a multi-hop payout instead of taking the last one", () => {
    const logs = [
      transfer(USDC, KURU_ENTRYPOINT, WALLET, 100n),
      transfer(USDC, KURU_ENTRYPOINT, WALLET, 23n),
    ];
    expect(tokensReceived(logs, WALLET)[USDC]).toBe(123n);
  });

  it("ignores transfers to somebody else", () => {
    // Every route moves tokens between routers and pools. Counting those as
    // the hunter's proceeds would overstate every trade.
    const other = "0x000000000000000000000000000000000000dead";
    expect(
      tokensReceived([transfer(USDC, WALLET, other, 999n)], WALLET),
    ).toEqual({});
  });

  it("ignores a non-Transfer event with the same shape", () => {
    const logs = [
      {
        address: USDC,
        topics: ["0xdeadbeef", pad(USDC), pad(WALLET)],
        data: "0x01",
      },
    ];
    expect(tokensReceived(logs, WALLET)).toEqual({});
  });

  it("matches the wallet case-insensitively", () => {
    expect(tokensReceived(REAL.logs, WALLET.toLowerCase())[USDC]).toBe(
      123_884n,
    );
  });
});

describe("toRecord", () => {
  const HASH =
    "0x95f1426966365e3c78ea7fb5f38339c4b310c753db7205745f62d68e7baf2bb0";

  it("records the real trade, honestly, including the venue it did NOT use", () => {
    const r = toRecord(HASH, WALLET, 5_000_000_000_000_000_000n, REAL);
    expect(r.ok).toBe(true);
    expect(r.crossedOrderBook).toBe(false);
    expect(r.tokensIn[USDC]).toBe(123_884n);
    expect(r.valueWei).toBe(5_000_000_000_000_000_000n);
    expect(r.wallet).toBe(WALLET.toLowerCase());
  });

  it("refuses a transaction somebody else sent", () => {
    // Without this a hunter files a stranger's trade under their own address —
    // a good one to look richer, or a reverted one to complain about.
    expect(() =>
      toRecord(HASH, "0x000000000000000000000000000000000000dead", 0n, REAL),
    ).toThrow(NotAKuruTrade);
  });

  it("refuses a transaction that never went to Kuru", () => {
    // Otherwise this is a free "record any transaction you like" endpoint.
    expect(() =>
      toRecord(HASH, WALLET, 0n, {
        ...REAL,
        to: "0x000000000000000000000000000000000000dead",
      }),
    ).toThrow(NotAKuruTrade);
  });

  it("KEEPS a revert — it cost the full gas limit and delivered nothing", () => {
    // The expensive half of the record. A log showing only fills hides exactly
    // the trades a hunter needs to find again.
    const r = toRecord(HASH, WALLET, 5n * 10n ** 18n, {
      ...REAL,
      status: "reverted",
      logs: [],
    });
    expect(r.ok).toBe(false);
    expect(r.gasWei).toBe(95_229_342_000_000_000n);
    expect(r.tokensIn).toEqual({});
    expect(r.crossedOrderBook).toBe(false);
  });

  it("never claims the book on a reverted trade, even if logs suggest it", () => {
    // A reverted transaction emits nothing, so any logs here are nonsense; the
    // status decides, not the payload.
    const r = toRecord(HASH, WALLET, 0n, {
      ...REAL,
      status: "reverted",
      logs: [{ address: MARKET, topics: [], data: "0x" }],
    });
    expect(r.crossedOrderBook).toBe(false);
  });

  it("lowercases the hash so one trade cannot be stored twice", () => {
    expect(toRecord(HASH.toUpperCase(), WALLET, 0n, REAL).hash).toBe(HASH);
  });
});
