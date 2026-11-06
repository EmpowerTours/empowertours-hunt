import { describe, expect, it } from "vitest";
import {
  MAX_PENDING,
  MINUTE,
  PASSES,
  QUOTE_MS,
  ROUNDS,
  SETTLE_GRACE_MS,
  TAKE_MS,
  TIMEOUT_PENALTY,
  GameError,
  botQuote,
  checkQuote,
  closeFor,
  current,
  finished,
  newMatch,
  pending,
  quote,
  score,
  settleMinute,
  spreadLimits,
  take,
  tick,
  type Candle,
  type Market,
  type Match,
} from "./game";

const T0 = Date.UTC(2026, 10, 5, 18, 0, 10); // 10 s into a minute
const flat: Market = { price: 17500, closes: [17500, 17500, 17500, 17500] };
const half = () => 0.5;
const candle = (t: number, c: number): Candle => ({
  t,
  o: c,
  h: c,
  l: c,
  c,
  n: 2,
});

function opened(now = T0, market = flat): Match {
  return tick(newMatch(now), now, market, [], half).match;
}

describe("quotes", () => {
  it("must straddle the price, inside the spread limits", () => {
    const { min, max } = spreadLimits(17500); // 2 bps .. 60 bps of $0.0175
    expect(min).toBe(4);
    expect(max).toBe(105);
    expect(checkQuote(17500, 17498, 17502)).toBeNull();
    expect(checkQuote(17500, 17500, 17504)).toBe("price_not_between");
    expect(checkQuote(17500, 17499, 17501)).toBe("spread_too_small");
    expect(checkQuote(17500, 17400, 17600)).toBe("spread_too_wide");
    expect(checkQuote(17500, 17502, 17498)).toBe("inverted");
    expect(checkQuote(17500, 17498.5, 17502)).toBe("bad_number");
  });

  it("the bot's quotes are always legal, whatever the chart did", () => {
    let seed = 7;
    const rng = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 2000; i++) {
      const ref = 17000 + Math.floor(rng() * 1000);
      const closes = Array.from(
        { length: 12 },
        () => ref + Math.round((rng() - 0.5) * 200),
      );
      const q = botQuote(ref, closes, rng);
      expect(checkQuote(ref, q.bid, q.ask)).toBeNull();
    }
  });
});

describe("a round the bot quotes", () => {
  it("opens with the bot's walls and gives the player TAKE_MS", () => {
    const m = opened();
    const r = current(m)!;
    expect(r).toMatchObject({ n: 1, quoter: "bot", ref: 17500 });
    expect(r.bid).toBeLessThan(17500);
    expect(r.ask).toBeGreaterThan(17500);
    expect(() => take(m, T0 + TAKE_MS, "buy")).toThrow(GameError);
  });

  it("a buy settles on the close of the minute AFTER the click, never the one it was made in", () => {
    // opened 45 s into a minute, clicked at 59 s: still a full minute to wait
    const at = T0 + 35_000;
    let m = take(opened(at), at + 14_000, "buy");
    const r = m.rounds[0];
    expect(r.settleT).toBe(settleMinute(T0));
    expect(r.settleT! - (at + 14_000)).toBe(1_000);
    const close = r.ask! + 7;
    const done = r.settleT! + MINUTE + SETTLE_GRACE_MS;
    // not before the minute is final
    expect(
      tick(m, done - 1, flat, [candle(r.settleT!, close)], half).match.rounds[0]
        .you,
    ).toBeNull();
    m = tick(m, done, flat, [candle(r.settleT!, close)], half).match;
    expect(m.rounds[0].close).toBe(close);
    expect(m.rounds[0].you).toBe(Math.round((7 * 1e5) / 17500)); // 40 = 4.0 points
    expect(score(m)).toBe(40);
  });

  it("a sell wins when the close is below the bid, and the bot loses what the player wins", () => {
    let m = take(opened(), T0 + 1_000, "sell");
    const r = m.rounds[0];
    m = tick(
      m,
      r.settleT! + MINUTE + SETTLE_GRACE_MS,
      flat,
      [candle(r.settleT!, r.bid! - 3)],
      half,
    ).match;
    expect(m.rounds[0].you).toBe(Math.round((3 * 1e5) / 17500));
  });

  it("a minute nobody traded settles at the last price before it", () => {
    const m = take(opened(), T0, "buy");
    const t = m.rounds[0].settleT!;
    const cs = [candle(t - MINUTE, 17510), candle(t + MINUTE, 17600)];
    expect(closeFor(t, cs, t + 2 * MINUTE)).toBe(17510);
    // and waits while the feed has not moved past it
    expect(
      closeFor(t, [candle(t - MINUTE, 17510)], t + MINUTE + SETTLE_GRACE_MS),
    ).toBeNull();
  });

  it("running out the clock uses a pass, then costs a penalty", () => {
    let m = opened();
    m = tick(m, T0 + TAKE_MS, flat, [], half).match;
    expect(m.rounds[0]).toMatchObject({ action: "pass", you: 0 });
    expect(m.passes.you).toBe(PASSES - 1);
    m = { ...m, passes: { ...m.passes, you: 0 } };
    // round 2 is the player's quote; let it lapse too
    const r2 = current(m)!;
    expect(r2.quoter).toBe("you");
    m = tick(m, r2.openedAt + QUOTE_MS, flat, [], half).match;
    expect(m.rounds[1]).toMatchObject({
      action: "timeout",
      you: -TIMEOUT_PENALTY,
    });
  });

  it("refuses a pass with none left", () => {
    const m = opened();
    expect(() =>
      take({ ...m, passes: { you: 0, bot: 2 } }, T0, "pass"),
    ).toThrow("no_passes");
  });
});

describe("a round the player quotes", () => {
  it("the bot answers at once and the quote is checked against the live price", () => {
    let m = take(opened(), T0, "pass");
    m = tick(m, T0 + 1, flat, [], half).match;
    expect(current(m)!.quoter).toBe("you");
    expect(() => quote(m, T0 + 2, flat, 0, 4, half)).toThrow(
      "price_not_between",
    );
    m = quote(m, T0 + 2, flat, 4, 4, half);
    expect(m.rounds[1].action).toMatch(/buy|sell|pass/);
    expect(m.rounds[1].lockedAt).toBe(T0 + 2);
  });

  it("walls are placed around the live price when the quote arrives, even if it moved", () => {
    let m = tick(take(opened(), T0, "pass"), T0, flat, [], half).match;
    // the player saw 17500; MON traded at 17540 before the quote arrived
    const moved: Market = { price: 17540, closes: flat.closes };
    m = quote(m, T0 + 5, moved, 6, 6, half);
    expect(m.rounds[1]).toMatchObject({ ref: 17540, bid: 17534, ask: 17546 });
  });

  it("a very wide quote gets passed by the bot while it has passes", () => {
    let m = tick(take(opened(), T0, "pass"), T0, flat, [], half).match;
    m = quote(m, T0 + 1, flat, 50, 50, half);
    expect(m.rounds[1]).toMatchObject({ action: "pass", you: 0 });
    expect(m.passes.bot).toBe(PASSES - 1);
  });
});

describe("a match", () => {
  it("keeps at most MAX_PENDING trades waiting and finishes after ROUNDS settle", () => {
    let m = newMatch(T0);
    let now = T0;
    const candles: Candle[] = [];
    for (let guard = 0; guard < 500 && !finished(m); guard++) {
      m = tick(m, now, flat, candles, half).match;
      expect(pending(m).length).toBeLessThanOrEqual(MAX_PENDING);
      const r = current(m);
      if (r?.quoter === "bot") m = take(m, now, "buy");
      else if (r?.quoter === "you") m = quote(m, now, flat, 4, 4, half);
      now += 10_000;
      const minute = Math.floor(now / MINUTE) * MINUTE;
      if (!candles.some((c) => c.t === minute - MINUTE))
        candles.push(candle(minute - MINUTE, 17500));
    }
    expect(finished(m)).toBe(true);
    expect(m.rounds).toHaveLength(ROUNDS);
    // the clock between the first click and the end is about a round a minute
    expect(now - T0).toBeLessThan((ROUNDS + 3) * MINUTE);
  });

  it("opens no round while the feed has no price", () => {
    const m = tick(
      newMatch(T0),
      T0,
      { price: null, closes: [] },
      [],
      half,
    ).match;
    expect(m.rounds).toHaveLength(0);
  });
});
