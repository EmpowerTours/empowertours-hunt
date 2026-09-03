import { describe, expect, it } from "vitest";
import {
  mayOpen,
  mustClose,
  utcDayKey,
  type DayState,
  type EnforcedBound,
  type ProposedOrder,
} from "./enforce";
import { leverageX100, usdE6 } from "./scale";

const NOW = BigInt(Math.floor(Date.UTC(2026, 8, 2, 12, 0, 0) / 1000));

function bound(over: Partial<EnforcedBound> = {}): EnforcedBound {
  return {
    venue: "perpl",
    markets: ["BTC"],
    maxNotionalUsdE6: usdE6(200),
    maxLeverageX100: leverageX100(3),
    maxDailyLossUsdE6: usdE6(50),
    maxTradesPerDay: 10,
    notBefore: NOW - 3600n,
    notAfter: NOW + 30n * 86400n,
    revokedAt: null,
    ...over,
  };
}

function day(over: Partial<DayState> = {}): DayState {
  return {
    tradesToday: 0,
    lossTodayUsdE6: 0n,
    openNotionalUsdE6: 0n,
    ...over,
  };
}

function order(over: Partial<ProposedOrder> = {}): ProposedOrder {
  return {
    venue: "perpl",
    market: "BTC",
    notionalUsdE6: usdE6(100),
    leverageX100: leverageX100(2),
    ...over,
  };
}

describe("an order inside every ceiling", () => {
  it("is allowed", () => {
    expect(mayOpen(bound(), day(), order(), NOW)).toEqual({ ok: true });
  });
});

describe("the bound has to be live before anything else matters", () => {
  it("refuses a revoked bound even with budget and window intact", () => {
    const b = bound({ revokedAt: new Date() });
    expect(mayOpen(b, day(), order(), NOW)).toEqual({
      ok: false,
      reason: "revoked",
    });
  });

  it("refuses before notBefore and after notAfter", () => {
    const b = bound({ notBefore: NOW + 60n });
    expect(mayOpen(b, day(), order(), NOW)).toEqual({
      ok: false,
      reason: "not_yet_valid",
    });

    const c = bound({ notAfter: NOW - 1n });
    expect(mayOpen(c, day(), order(), NOW)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("is inclusive at both edges of the window", () => {
    // notBefore and notAfter are the moments the player named. A bound that
    // is dead ON its own start second would be off by one against the number
    // they read and signed.
    expect(mayOpen(bound({ notBefore: NOW }), day(), order(), NOW).ok).toBe(
      true,
    );
    expect(mayOpen(bound({ notAfter: NOW }), day(), order(), NOW).ok).toBe(
      true,
    );
  });

  it("reports liveness ahead of a numeric breach", () => {
    // An expired bound whose order also breaks leverage must say "expired".
    // Naming the leverage would send the player to fix the wrong thing.
    const b = bound({ notAfter: NOW - 1n });
    const o = order({ leverageX100: leverageX100(50) });
    expect(mayOpen(b, day(), o, NOW)).toEqual({ ok: false, reason: "expired" });
  });
});

describe("authority: venue and market", () => {
  it("refuses another venue", () => {
    expect(mayOpen(bound(), day(), order({ venue: "kuru" }), NOW)).toEqual({
      ok: false,
      reason: "wrong_venue",
    });
  });

  it("refuses a market the bound does not name", () => {
    expect(mayOpen(bound(), day(), order({ market: "DOGE" }), NOW)).toEqual({
      ok: false,
      reason: "market_not_authorised",
    });
  });

  it("authorises nothing when the market list is empty", () => {
    // An empty list is a revocation the player can prove they signed. It must
    // deny every market, not fall through as "no restriction configured".
    const b = bound({ markets: [] });
    expect(mayOpen(b, day(), order(), NOW)).toEqual({
      ok: false,
      reason: "market_not_authorised",
    });
  });
});

describe("the notional ceiling cannot be defeated by splitting", () => {
  it("counts open notional, not just the order in hand", () => {
    // The attack: a $200 bound, an order of $200 that is allowed, and then a
    // second $200 order. Per-order accounting passes both and the player is
    // carrying $400 against a number they wrote as 200.
    const b = bound({ maxNotionalUsdE6: usdE6(200) });

    const first = mayOpen(b, day(), order({ notionalUsdE6: usdE6(200) }), NOW);
    expect(first.ok).toBe(true);

    const after = day({ openNotionalUsdE6: usdE6(200) });
    expect(
      mayOpen(b, after, order({ notionalUsdE6: usdE6(200) }), NOW),
    ).toEqual({
      ok: false,
      reason: "notional_exceeded",
    });
  });

  it("refuses the order that would cross the line, not merely the one past it", () => {
    const b = bound({ maxNotionalUsdE6: usdE6(200) });
    const state = day({ openNotionalUsdE6: usdE6(150) });

    expect(mayOpen(b, state, order({ notionalUsdE6: usdE6(50) }), NOW).ok).toBe(
      true,
    );
    expect(
      mayOpen(b, state, order({ notionalUsdE6: usdE6(50.000001) }), NOW),
    ).toEqual({ ok: false, reason: "notional_exceeded" });
  });
});

describe("leverage", () => {
  it("allows exactly the ceiling and refuses one hundredth above it", () => {
    const b = bound({ maxLeverageX100: leverageX100(3) });
    expect(
      mayOpen(b, day(), order({ leverageX100: leverageX100(3) }), NOW).ok,
    ).toBe(true);
    expect(
      mayOpen(b, day(), order({ leverageX100: leverageX100(3.01) }), NOW),
    ).toEqual({ ok: false, reason: "leverage_exceeded" });
  });
});

describe("trade count", () => {
  it("spends exactly maxTradesPerDay and no more", () => {
    const b = bound({ maxTradesPerDay: 3 });
    expect(mayOpen(b, day({ tradesToday: 2 }), order(), NOW).ok).toBe(true);
    expect(mayOpen(b, day({ tradesToday: 3 }), order(), NOW)).toEqual({
      ok: false,
      reason: "trade_count_exceeded",
    });
  });
});

describe("the daily loss ceiling", () => {
  it("stops at the number, not one order past it", () => {
    const b = bound({ maxDailyLossUsdE6: usdE6(50) });
    expect(
      mayOpen(b, day({ lossTodayUsdE6: usdE6(49.99) }), order(), NOW).ok,
    ).toBe(true);
    expect(
      mayOpen(b, day({ lossTodayUsdE6: usdE6(50) }), order(), NOW),
    ).toEqual({
      ok: false,
      reason: "daily_loss_reached",
    });
  });

  it("outranks a spare trade budget", () => {
    // Having trades left is not permission to keep losing. If these were
    // checked the other way round the player would be told they had run out
    // of trades, which is both wrong and reassuring.
    const b = bound({ maxDailyLossUsdE6: usdE6(50), maxTradesPerDay: 10 });
    const state = day({ lossTodayUsdE6: usdE6(80), tradesToday: 0 });
    expect(mayOpen(b, state, order(), NOW)).toEqual({
      ok: false,
      reason: "daily_loss_reached",
    });
  });
});

describe("mustClose is what makes the loss ceiling real", () => {
  it("demands a close once the loss ceiling is reached", () => {
    // Nobody placed an order here. The position drifted into the number on
    // its own, which is exactly the case mayOpen alone cannot catch.
    const b = bound({ maxDailyLossUsdE6: usdE6(50) });
    expect(mustClose(b, day({ lossTodayUsdE6: usdE6(50) }), NOW)).toEqual({
      ok: false,
      reason: "daily_loss_reached",
    });
  });

  it("leaves a healthy position alone", () => {
    expect(mustClose(bound(), day({ lossTodayUsdE6: usdE6(10) }), NOW)).toEqual(
      {
        ok: true,
      },
    );
  });

  it("demands a close when the bound expires under an open position", () => {
    // A position must not outlive the agreement that authorised it.
    const b = bound({ notAfter: NOW - 1n });
    expect(mustClose(b, day(), NOW)).toEqual({ ok: false, reason: "expired" });
  });

  it("demands a close on revocation", () => {
    const b = bound({ revokedAt: new Date() });
    expect(mustClose(b, day(), NOW)).toEqual({ ok: false, reason: "revoked" });
  });
});

describe("the two entry points cannot disagree about liveness", () => {
  it("gives the same reason for every dead bound", () => {
    // If mayOpen thought a bound was live while mustClose thought it dead
    // (or the reverse), an agent would oscillate between opening a position
    // and being told to flatten it.
    const dead: EnforcedBound[] = [
      bound({ revokedAt: new Date() }),
      bound({ notBefore: NOW + 60n }),
      bound({ notAfter: NOW - 1n }),
    ];

    for (const b of dead) {
      const open = mayOpen(b, day(), order(), NOW);
      const close = mustClose(b, day(), NOW);
      expect(open.ok).toBe(false);
      expect(close.ok).toBe(false);
      if (!open.ok && !close.ok) expect(open.reason).toBe(close.reason);
    }
  });
});

describe("the UTC day boundary", () => {
  it("rolls at midnight UTC, not at a local midnight", () => {
    expect(utcDayKey(new Date("2026-09-02T23:59:59Z"))).toBe("2026-09-02");
    expect(utcDayKey(new Date("2026-09-03T00:00:00Z"))).toBe("2026-09-03");
  });

  it("puts a late-evening Mexico City moment in the NEXT UTC day", () => {
    // CDMX is UTC-6, so 19:00 local is 01:00 UTC tomorrow. A player trading
    // in the evening gets their allowance back mid-session. That is a real
    // consequence of choosing UTC and it should be visible in a test rather
    // than discovered by somebody in Guerrero.
    expect(utcDayKey(new Date("2026-09-02T01:00:00Z"))).toBe("2026-09-02");
    expect(utcDayKey(new Date("2026-09-03T01:00:00Z"))).toBe("2026-09-03");
  });
});
