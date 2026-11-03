// ---------------------------------------------------------------------------
// Feeding Perpl's real trading into a game, one candle at a time.
//
// The game does not invent a price. Every move the ball makes is a trade that
// happened on Perpl's MON market, read back as one-minute candles. That keeps
// the play game honest in the one way that matters for what it teaches: a wall
// fills only where somebody actually traded.
//
// THE CANDLE IN PROGRESS. Perpl returns the current minute while it is still
// forming, and a player who polls every few seconds sees the same minute grow.
// The cursor remembers how much of that minute has already been applied (its
// high, its low, where it stood), so the next poll applies only what is new
// rather than replaying the extremes again.
//
// Pure: no clock, no network. lib/cotas/feed.ts does the fetching.
// ---------------------------------------------------------------------------

import { applySegment, type GameEvent, type GameState } from "./engine";

export interface Candle {
  /** Open time, ms. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Trades in the minute. */
  n: number;
}

export interface Cursor {
  t: number;
  hi: number;
  lo: number;
  close: number;
}

export interface TimedEvent {
  event: GameEvent;
  candleAt: number;
}

/** Reject anything that is not a well-formed candle. A feed we cannot read is a feed we do not trade on. */
export function validCandle(c: Candle): boolean {
  const ints = [c.t, c.o, c.h, c.l, c.c, c.n].every(Number.isSafeInteger);
  return (
    ints &&
    c.o > 0 &&
    c.l > 0 &&
    c.n >= 0 &&
    c.h >= Math.max(c.o, c.c) &&
    c.l <= Math.min(c.o, c.c)
  );
}

export function cursorFrom(c: Candle): Cursor {
  return { t: c.t, hi: c.h, lo: c.l, close: c.c };
}

/**
 * Apply every candle after the cursor. Candles must be sorted by time; any
 * malformed candle stops the whole batch (and the caller keeps the old state),
 * because applying half a minute and skipping the rest would book a result the
 * market did not produce.
 */
export function advance(
  state: GameState,
  cursor: Cursor,
  candles: Candle[],
): { state: GameState; cursor: Cursor; events: TimedEvent[] } {
  let s = state;
  let cur = cursor;
  const events: TimedEvent[] = [];
  let lastT = -Infinity;

  for (const c of candles) {
    if (!validCandle(c)) throw new Error(`malformed candle at ${c.t}`);
    if (c.t <= lastT) throw new Error("candles out of order");
    lastT = c.t;
    if (c.t < cur.t) continue;

    let seg: { hi: number; lo: number; close: number } | null = null;
    if (c.t === cur.t) {
      // The same minute, grown since we last looked. Only the part we have not
      // applied counts: a new high, a new low, and where it is now.
      const newHi = c.h > cur.hi;
      const newLo = c.l < cur.lo;
      if (newHi || newLo || c.c !== cur.close) {
        seg = {
          hi: newHi ? c.h : Math.max(cur.close, c.c),
          lo: newLo ? c.l : Math.min(cur.close, c.c),
          close: c.c,
        };
      }
    } else if (c.n > 0) {
      // A minute with no trades has nothing to apply: its price is a copy of
      // the last one, not a trade.
      seg = { hi: c.h, lo: c.l, close: c.c };
    }

    if (seg) {
      const r = applySegment(s, seg);
      s = r.state;
      for (const e of r.events) events.push({ event: e, candleAt: c.t });
    }
    cur =
      c.t === cur.t
        ? {
            t: c.t,
            hi: Math.max(cur.hi, c.h),
            lo: Math.min(cur.lo, c.l),
            close: c.c,
          }
        : cursorFrom(c);
  }
  return { state: s, cursor: cur, events };
}
