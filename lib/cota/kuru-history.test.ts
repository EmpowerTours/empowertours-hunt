import { describe, expect, it } from "vitest";
import {
  KURU_ENTRYPOINT,
  KURU_SWAP_EVENT,
  NotAKuruTrade,
  crossedOrderBook,
  gasChargedWei,
  nativeReceived,
  nativeReceivedFromTrace,
  toRecord,
  tokensReceived,
  type MinimalReceipt,
} from "./kuru-history";
import { KURU_MON_USDC_MARKET } from "./kuru";
import {
  BUY_ORDER_BOOK,
  BUY_PAID_ELSEWHERE,
  BUY_POOL,
  REVERT,
  SELL_ORDER_BOOK,
  SELL_POOL,
} from "./kuru-history.fixtures";

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

// ---------------------------------------------------------------------------
// Native MON received — the number a buy never had.
//
// Each expected figure below was taken from TWO sources before it was written
// here: the entrypoint's swap event (what the decoder reads) and a callTracer
// trace of the same transaction (what it does not). They agreed to the wei in
// every case. Where only one source could have been checked the test says so.
// ---------------------------------------------------------------------------

describe("nativeReceived — MON that actually reached the wallet", () => {
  it("decodes a buy that crossed the order book", () => {
    // 100.000000 USDC in. Trace of the same tx: 2938583602703400000000 wei to
    // 0xfe8c49fc…, which is the figure below.
    expect(
      nativeReceived(BUY_ORDER_BOOK.receipt.logs, BUY_ORDER_BOOK.receipt.from),
    ).toBe(2_938_583_602_703_400_000_000n);
  });

  it("decodes a buy routed to a pool, where the book event is absent", () => {
    // The whole reason for reading the entrypoint rather than the market: this
    // transaction never touched the book, so a book-event decoder would report
    // nothing at all here.
    expect(crossedOrderBook(BUY_POOL.receipt.logs)).toBe(false);
    expect(nativeReceived(BUY_POOL.receipt.logs, BUY_POOL.receipt.from)).toBe(
      95_635_194_247_000_693_887n,
    );
  });

  it("credits the recipient in the event, not the sender, when they differ", () => {
    // 0x23f3d831…9f11 was sent by 0xc066ac5d… and paid out to 0x5458b5ca…. A
    // trace confirms the direction: the whole amount reached the address named
    // in the event and nothing reached the sender. Had this been read off the
    // sender instead, the figure would have been attributed to the wrong wallet.
    const sender = BUY_PAID_ELSEWHERE.receipt.from;
    const paid = "0x5458b5ca6a82660bd09924c5371bd379fb4e20cc";
    expect(sender).not.toBe(paid);
    expect(nativeReceived(BUY_PAID_ELSEWHERE.receipt.logs, paid)).toBe(
      29_877_261_360_379_321_582_422n,
    );
    // And for the sender it is a KNOWN nought, not an unknown: the event was
    // there and readable, it simply paid somebody else.
    expect(nativeReceived(BUY_PAID_ELSEWHERE.receipt.logs, sender)).toBe(0n);
  });

  it("reports a known zero on a sell, because the output was an ERC-20", () => {
    for (const f of [SELL_ORDER_BOOK, SELL_POOL]) {
      expect(nativeReceived(f.receipt.logs, f.receipt.from)).toBe(0n);
    }
  });

  it("reports null — not zero — when no swap event is present", () => {
    // A revert emits nothing at all, so there is no evidence either way. This
    // is the distinction the nullable column exists for: a zero here would
    // claim the hunter received nothing, which is a claim, whereas null admits
    // the amount is unestablished.
    expect(REVERT.receipt.logs).toHaveLength(0);
    expect(nativeReceived(REVERT.receipt.logs, REVERT.receipt.from)).toBeNull();
  });

  it("ignores the same event emitted by a contract that is not the entrypoint", () => {
    // Anyone can emit any topic from any address. If this matched, a worthless
    // token could mint MON into our leaderboard for the price of one log.
    const real = BUY_ORDER_BOOK.receipt.logs.find(
      (l) => l.address === KURU_ENTRYPOINT && l.topics[0] === KURU_SWAP_EVENT,
    );
    expect(real).toBeDefined();
    const impostor = { ...real!, address: "0x" + "ba".repeat(20) };
    expect(nativeReceived([impostor], BUY_ORDER_BOOK.receipt.from)).toBeNull();
  });

  it("is indifferent to the case of the wallet it is asked about", () => {
    const w = BUY_POOL.receipt.from;
    expect(
      nativeReceived(
        BUY_POOL.receipt.logs,
        w.toUpperCase().replace("0X", "0x"),
      ),
    ).toBe(nativeReceived(BUY_POOL.receipt.logs, w.toLowerCase()));
  });

  it("refuses truncated event data rather than reading a short word as a small number", () => {
    const real = BUY_ORDER_BOOK.receipt.logs.find(
      (l) => l.address === KURU_ENTRYPOINT && l.topics[0] === KURU_SWAP_EVENT,
    )!;
    const cut = { ...real, data: real.data.slice(0, 2 + 64 * 3) };
    expect(() => nativeReceived([cut], BUY_ORDER_BOOK.receipt.from)).toThrow(
      NotAKuruTrade,
    );
  });

  it("sums several legs that each paid the same wallet", () => {
    const real = BUY_ORDER_BOOK.receipt.logs.find(
      (l) => l.address === KURU_ENTRYPOINT && l.topics[0] === KURU_SWAP_EVENT,
    )!;
    expect(nativeReceived([real, real], BUY_ORDER_BOOK.receipt.from)).toBe(
      2_938_583_602_703_400_000_000n * 2n,
    );
  });
});

describe("toRecord — the stored row carries the MON figure", () => {
  it("stores the decoded amount on a buy and leaves the ERC-20 map empty", () => {
    const r = toRecord(
      BUY_ORDER_BOOK.hash,
      BUY_ORDER_BOOK.receipt.from,
      BUY_ORDER_BOOK.value,
      BUY_ORDER_BOOK.receipt,
    );
    expect(r.nativeInWei).toBe(2_938_583_602_703_400_000_000n);
    // The old behaviour, unchanged and still the reason this column was needed:
    // the buy's output is native, so nothing lands in tokensIn.
    expect(
      r.tokensIn["0x0000000000000000000000000000000000000000"],
    ).toBeUndefined();
  });

  it("stores zero on a revert, which is known rather than unknown", () => {
    const r = toRecord(
      REVERT.hash,
      REVERT.receipt.from,
      REVERT.value,
      REVERT.receipt,
    );
    expect(r.ok).toBe(false);
    expect(r.nativeInWei).toBe(0n);
    // And the row is still worth keeping: it cost the whole gas limit.
    expect(r.gasWei).toBe(
      REVERT.receipt.gasUsed * REVERT.receipt.effectiveGasPrice,
    );
  });

  it("stores zero on a sell while the USDC still arrives in tokensIn", () => {
    const r = toRecord(
      SELL_ORDER_BOOK.hash,
      SELL_ORDER_BOOK.receipt.from,
      SELL_ORDER_BOOK.value,
      SELL_ORDER_BOOK.receipt,
    );
    expect(r.nativeInWei).toBe(0n);
    expect(r.tokensIn[USDC]).toBe(198_992n);
    expect(r.valueWei).toBe(8_000_000_000_000_000_000n);
    expect(r.crossedOrderBook).toBe(true);
  });
});

describe("nativeReceivedFromTrace — the fallback", () => {
  it("sums value delivered to the wallet across nested frames", () => {
    const frame = {
      to: "0xb3e6778480b2e488385e8205ea05e20060b813cb",
      value: "0x0",
      calls: [
        { to: "0xAAaa".padEnd(42, "0"), value: "0x1" },
        { to: "0xabc", value: "0xa", calls: [{ to: "0xABC", value: "0x6" }] },
      ],
    };
    expect(nativeReceivedFromTrace(frame, "0xabc")).toBe(16n);
  });

  it("skips a reverted frame and everything under it", () => {
    // A frame that threw moved no value, and neither did its children. Counting
    // them would report MON the wallet never got.
    const frame = {
      to: "0x0",
      calls: [
        { to: "0xabc", value: "0x5" },
        {
          to: "0x0",
          error: "execution reverted",
          calls: [{ to: "0xabc", value: "0x63" }],
        },
      ],
    };
    expect(nativeReceivedFromTrace(frame, "0xabc")).toBe(5n);
  });

  it("returns zero rather than throwing on a frame with no value or calls", () => {
    expect(nativeReceivedFromTrace({ to: "0xabc" }, "0xabc")).toBe(0n);
  });
});
