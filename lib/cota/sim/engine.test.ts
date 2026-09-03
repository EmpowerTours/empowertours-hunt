import { describe, expect, it } from "vitest";
import {
  checkMustClose,
  close,
  closeAll,
  emptyAccount,
  formatUsdE6,
  netPnlUsdE6,
  open,
  rollDay,
  toDayState,
  unrealisedPnlUsdE6,
  type PaperAccount,
  type PaperPosition,
} from "./engine";
import { parseMarks, toUsdE6 } from "./prices";
import { leverageX100, usdE6 } from "../scale";
import type { EnforcedBound } from "../enforce";

const AT = new Date("2026-09-02T12:00:00Z");
const NEXT_DAY = new Date("2026-09-03T00:30:00Z");
const NOW_S = BigInt(Math.floor(AT.getTime() / 1000));

function bound(over: Partial<EnforcedBound> = {}): EnforcedBound {
  return {
    venue: "perpl",
    markets: ["BTC"],
    maxNotionalUsdE6: usdE6(200),
    maxLeverageX100: leverageX100(3),
    maxDailyLossUsdE6: usdE6(50),
    maxTradesPerDay: 10,
    notBefore: NOW_S - 3600n,
    notAfter: NOW_S + 30n * 86400n,
    revokedAt: null,
    ...over,
  };
}

/** Marks keyed by market, e6 USD. */
function marks(btc: number): Map<string, bigint> {
  return new Map([["BTC", usdE6(btc)]]);
}

function longAt(entry: number, notional: number): PaperPosition {
  return {
    market: "BTC",
    side: "long",
    notionalUsdE6: usdE6(notional),
    entryUsdE6: usdE6(entry),
    leverageX100: leverageX100(2),
    openedAt: AT,
  };
}

describe("mark to market", () => {
  it("prices a long by the percentage the market moved", () => {
    // $100 notional entered at 100, market at 90: down a tenth, so -$10.
    expect(unrealisedPnlUsdE6(longAt(100, 100), usdE6(90))).toBe(-usdE6(10));
    expect(unrealisedPnlUsdE6(longAt(100, 100), usdE6(110))).toBe(usdE6(10));
  });

  it("inverts for a short", () => {
    const short: PaperPosition = { ...longAt(100, 100), side: "short" };
    expect(unrealisedPnlUsdE6(short, usdE6(90))).toBe(usdE6(10));
    expect(unrealisedPnlUsdE6(short, usdE6(110))).toBe(-usdE6(10));
  });

  it("returns nothing rather than dividing by a missing price", () => {
    expect(unrealisedPnlUsdE6(longAt(100, 100), 0n)).toBe(0n);
  });
});

describe("an open loser constrains the next trade", () => {
  it("blocks a new order once unrealised loss reaches the ceiling", () => {
    // Nothing was realised and no extra order was placed. The position simply
    // moved, and the bound notices — this is the case a check that only runs
    // at order time cannot see.
    const b = bound({ maxDailyLossUsdE6: usdE6(50) });
    const account: PaperAccount = {
      ...emptyAccount(AT),
      positions: [longAt(100, 100)],
    };

    // Down 50%: $100 notional is $50 in the hole, exactly the ceiling.
    const result = open(
      account,
      b,
      {
        market: "BTC",
        side: "long",
        notionalUsdE6: usdE6(10),
        leverageX100: leverageX100(1),
      },
      marks(50),
      AT,
    );

    expect(result.ok).toBe(false);
    if (!result.ok && !result.decision.ok) {
      expect(result.decision.reason).toBe("daily_loss_reached");
    }
  });

  it("still allows a trade while the position is only slightly down", () => {
    const account: PaperAccount = {
      ...emptyAccount(AT),
      positions: [longAt(100, 100)],
    };
    const result = open(
      account,
      bound(),
      {
        market: "BTC",
        side: "long",
        notionalUsdE6: usdE6(10),
        leverageX100: leverageX100(1),
      },
      marks(95),
      AT,
    );
    expect(result.ok).toBe(true);
  });
});

describe("the notional ceiling holds through the engine", () => {
  it("refuses a second order that would breach it in aggregate", () => {
    const b = bound({ maxNotionalUsdE6: usdE6(200) });
    const first = open(
      emptyAccount(AT),
      b,
      {
        market: "BTC",
        side: "long",
        notionalUsdE6: usdE6(200),
        leverageX100: leverageX100(2),
      },
      marks(100),
      AT,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = open(
      first.account,
      b,
      {
        market: "BTC",
        side: "long",
        notionalUsdE6: usdE6(1),
        leverageX100: leverageX100(2),
      },
      marks(100),
      AT,
    );
    expect(second.ok).toBe(false);
    if (!second.ok && !second.decision.ok) {
      expect(second.decision.reason).toBe("notional_exceeded");
    }
  });
});

describe("closing is never refused", () => {
  it("flattens a book that has already breached the loss ceiling", () => {
    // Software that could not reduce risk because a limit was breached would
    // be the opposite of a safety mechanism.
    const account: PaperAccount = {
      ...emptyAccount(AT),
      positions: [longAt(100, 100)],
    };
    const b = bound({ maxDailyLossUsdE6: usdE6(10) });

    expect(checkMustClose(account, b, marks(50), AT).ok).toBe(false);

    const flat = closeAll(account, marks(50), AT);
    expect(flat.positions).toHaveLength(0);
    expect(flat.realisedPnlUsdE6).toBe(-usdE6(50));
  });

  it("banks the mark it closed at", () => {
    const account: PaperAccount = {
      ...emptyAccount(AT),
      positions: [longAt(100, 100)],
    };
    const after = close(account, account.positions[0], marks(110), AT);
    expect(after.realisedPnlUsdE6).toBe(usdE6(10));
    expect(after.positions).toHaveLength(0);
  });
});

describe("mustClose fires without anybody placing an order", () => {
  it("demands a flatten when the market moves through the ceiling", () => {
    const account: PaperAccount = {
      ...emptyAccount(AT),
      positions: [longAt(100, 100)],
    };
    const b = bound({ maxDailyLossUsdE6: usdE6(20) });

    expect(checkMustClose(account, b, marks(95), AT).ok).toBe(true);

    const decision = checkMustClose(account, b, marks(75), AT);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("daily_loss_reached");
  });
});

describe("the day roll", () => {
  it("resets trades and realised pnl", () => {
    const account: PaperAccount = {
      ...emptyAccount(AT),
      tradesToday: 7,
      realisedPnlUsdE6: -usdE6(40),
    };
    const rolled = rollDay(account, NEXT_DAY);
    expect(rolled.tradesToday).toBe(0);
    expect(rolled.realisedPnlUsdE6).toBe(0n);
    expect(rolled.dayKey).toBe("2026-09-03");
  });

  it("does NOT close positions", () => {
    // A trade left open overnight is still open. Clearing it at midnight
    // would let the loss ceiling be reset by waiting instead of by closing.
    const account: PaperAccount = {
      ...emptyAccount(AT),
      positions: [longAt(100, 100)],
    };
    const rolled = rollDay(account, NEXT_DAY);
    expect(rolled.positions).toHaveLength(1);

    // And the open loss still counts against the new day's ceiling.
    expect(toDayState(rolled, marks(50)).lossTodayUsdE6).toBe(usdE6(50));
  });

  it("leaves the account untouched inside the same day", () => {
    const account = { ...emptyAccount(AT), tradesToday: 3 };
    expect(rollDay(account, new Date("2026-09-02T23:59:00Z"))).toBe(account);
  });
});

describe("a winning day does not bank headroom", () => {
  it("reports zero loss rather than negative loss", () => {
    // If profit counted as negative loss, a player up $500 would carry an
    // extra $500 of permitted loss — quietly widening a number they wrote.
    const account: PaperAccount = {
      ...emptyAccount(AT),
      realisedPnlUsdE6: usdE6(500),
    };
    expect(toDayState(account, marks(100)).lossTodayUsdE6).toBe(0n);
  });
});

describe("no price, no fill", () => {
  it("refuses to open a position at a mark of zero", () => {
    const result = open(
      emptyAccount(AT),
      bound(),
      {
        market: "BTC",
        side: "long",
        notionalUsdE6: usdE6(10),
        leverageX100: leverageX100(1),
      },
      new Map(),
      AT,
    );
    expect(result.ok).toBe(false);
  });
});

describe("reading Perpl's public prices", () => {
  it("rescales an integer price by its own decimal count", () => {
    // BTC arrives as 772201 with price_decimals 1, meaning 77220.1.
    expect(toUsdE6(772201, 1)).toBe(77_220_100_000n);
    expect(toUsdE6("100", 0)).toBe(usdE6(100));
  });

  it("does not truncate a price finer than the venue scale", () => {
    expect(toUsdE6(1, 6)).toBe(1n);
    expect(toUsdE6(1, 2)).toBe(10_000n);
  });

  it("pulls mid prices out of a context payload", () => {
    const payload = {
      markets: [
        { name: "BTC", config: { price_decimals: 1 }, state: { mid: 772201 } },
        { name: "MON", config: { price_decimals: 6 }, state: { mid: 25500 } },
      ],
    };
    expect(parseMarks(payload)).toEqual([
      { market: "BTC", midUsdE6: 77_220_100_000n },
      { market: "MON", midUsdE6: 25_500n },
    ]);
  });

  it("drops malformed markets instead of pricing them at zero", () => {
    // A market defaulted to zero would read to the engine as a free entry.
    const payload = {
      markets: [
        { name: "GOOD", config: { price_decimals: 1 }, state: { mid: 100 } },
        { name: "NO_MID", config: { price_decimals: 1 }, state: {} },
        { name: "NO_DECIMALS", state: { mid: 100 } },
        { config: { price_decimals: 1 }, state: { mid: 100 } },
        { name: "ZERO", config: { price_decimals: 1 }, state: { mid: 0 } },
      ],
    };
    expect(parseMarks(payload).map((m) => m.market)).toEqual(["GOOD"]);
  });

  it("survives a payload that is not what we expect at all", () => {
    expect(parseMarks(null)).toEqual([]);
    expect(parseMarks({})).toEqual([]);
    expect(parseMarks({ markets: "nope" })).toEqual([]);
  });
});

describe("what the player sees", () => {
  it("formats dollars and cents with a sign", () => {
    expect(formatUsdE6(usdE6(12.34))).toBe("$12.34");
    expect(formatUsdE6(-usdE6(7.5))).toBe("-$7.50");
    expect(formatUsdE6(0n)).toBe("$0.00");
  });

  it("reports net pnl across realised and open", () => {
    const account: PaperAccount = {
      ...emptyAccount(AT),
      realisedPnlUsdE6: usdE6(5),
      positions: [longAt(100, 100)],
    };
    expect(netPnlUsdE6(account, marks(90))).toBe(-usdE6(5));
  });
});
