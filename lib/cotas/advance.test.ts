import { describe, expect, it } from "vitest";
import { advance, cursorFrom, validCandle, type Candle } from "./advance";
import { newGame, setWalls } from "./engine";

const W = { lo: 17500, hi: 17570 };
const c = (
  t: number,
  o: number,
  h: number,
  l: number,
  cl: number,
  n = 3,
): Candle => ({ t, o, h, l, c: cl, n });

function game() {
  return setWalls(newGame(17530), W, 1_000);
}

describe("advance", () => {
  it("applies only candles after the cursor", () => {
    const first = c(0, 17530, 17530, 17530, 17530);
    const r = advance(game(), cursorFrom(first), [
      first,
      c(60_000, 17530, 17540, 17498, 17520),
    ]);
    expect(r.events.map((e) => e.event.kind)).toEqual(["open"]);
    expect(r.events[0].candleAt).toBe(60_000);
    expect(r.cursor).toEqual({ t: 60_000, hi: 17540, lo: 17498, close: 17520 });
  });

  it("re-reading the same minute applies nothing new", () => {
    const k = c(60_000, 17530, 17540, 17498, 17520);
    const once = advance(game(), cursorFrom(c(0, 17530, 17530, 17530, 17530)), [
      k,
    ]);
    const twice = advance(once.state, once.cursor, [k]);
    expect(twice.events).toEqual([]);
    expect(twice.state).toEqual(once.state);
  });

  it("a minute that grows applies only its new extreme", () => {
    const start = cursorFrom(c(0, 17530, 17530, 17530, 17530));
    const early = advance(game(), start, [
      c(60_000, 17530, 17540, 17498, 17520),
    ]); // long from 17500
    const later = advance(early.state, early.cursor, [
      c(60_000, 17530, 17575, 17498, 17560),
    ]);
    expect(later.events.map((e) => e.event.kind)).toEqual(["cross"]);
  });

  it("skips minutes with no trades", () => {
    const start = cursorFrom(c(0, 17530, 17530, 17530, 17530));
    const r = advance(game(), start, [
      c(60_000, 17400, 17400, 17400, 17400, 0),
    ]);
    expect(r.events).toEqual([]);
    expect(r.state.last).toBe(17530);
  });

  it("refuses a malformed batch outright", () => {
    const start = cursorFrom(c(0, 17530, 17530, 17530, 17530));
    expect(() =>
      advance(game(), start, [c(60_000, 17530, 17520, 17498, 17525)]),
    ).toThrow(/malformed/);
    expect(() =>
      advance(game(), start, [
        c(120_000, 17530, 17540, 17520, 17530),
        c(60_000, 17530, 17540, 17520, 17530),
      ]),
    ).toThrow(/order/);
  });

  it("validCandle rejects inconsistent extremes and non-integers", () => {
    expect(validCandle(c(0, 100, 99, 98, 99))).toBe(false); // high below open
    expect(validCandle(c(0, 100, 101, 100.5, 100))).toBe(false);
    expect(validCandle(c(0, 100, 101, 99, 100))).toBe(true);
  });
});
