// ---------------------------------------------------------------------------
// Cotas: two walls, a ball, and the arithmetic of who won.
//
// The player sets a cota below and a cota above the MON price. The bottom wall
// buys and the top wall sells. Whichever the price touches first opens a trade;
// the other wall closes it for the gap. If the price instead runs through the
// entry wall to the leash, two gaps further out, the trade closes at a loss and
// the walls re-centre on the price.
//
// ## Pure by construction
//
// No clock, no database, no network, no randomness. The same prices in give the
// same state out, which is what makes a game replayable after the fact and a
// leaderboard row something we can recompute instead of something we have to
// trust. It is also how the backtest that sized this game was run: the server
// feeds this exact function Perpl's real trades.
//
// ## Units, all integers
//
//   price   Perpl's scaled price: 17549 is $0.017549 (1e6 per dollar).
//   qty     whole MON. Perpl's minimum order is 1 MON.
//   chips   micro-chips. 1 chip = 1,000,000. A chip is a play dollar: the
//           balance a player starts with is 1,000 chips, and P&L is the dollar
//           P&L the same trade would have made, so qty * price is already in
//           micro-chips with no conversion.
//
// Fees are Cota's real rates in tenths of a basis point: a wall that fills is a
// resting order (Perpl maker 0.9 + Cota 2 = 2.9 bps), a leash stop is a market
// order (taker 6.9 + 2 = 8.9 bps). Play money pays them too, because a game
// that hides the fee teaches the one lesson that loses real money later.
// ---------------------------------------------------------------------------

export const CHIP = 1_000_000;
export const START_CHIPS = 1_000 * CHIP;

/** Fees, in tenths of a basis point (1e5 = 100%). */
export const MAKER_FEE = 29;
export const TAKER_FEE = 89;
const FEE_DENOM = 100_000;

/** The leash sits this many gaps beyond the entry wall. */
export const LEASH_GAPS = 2;

/** Wall gap bounds, in tenths of a basis point of the bottom wall. */
export const MIN_GAP = 100; // 0.10%
export const MAX_GAP = 2_000; // 2.00%

/** Sizes a player may choose. 1x: the notional must be covered by chips. */
export const SIZES = [500, 1_000, 5_000] as const;
export type Size = (typeof SIZES)[number];

export interface Walls {
  lo: number;
  hi: number;
}

export interface GameState {
  walls: Walls | null;
  qty: Size;
  /** +1 long from the bottom wall, -1 short from the top, 0 flat. */
  pos: 0 | 1 | -1;
  entry: number;
  /** False after a crossing, until the price is back between the walls. */
  armed: boolean;
  /** Realized balance in micro-chips, after fees. Never includes open P&L. */
  balance: number;
  /** Last price the engine has applied. */
  last: number;
  crossings: number;
  escapes: number;
  streak: number;
  bestStreak: number;
  fees: number;
}

export type GameEvent =
  | { kind: "open"; side: 1 | -1; price: number; qty: number; fee: number }
  | {
      kind: "cross";
      side: 1 | -1;
      price: number;
      entry: number;
      qty: number;
      pnl: number;
      fee: number;
    }
  | {
      kind: "escape";
      side: 1 | -1;
      price: number;
      entry: number;
      qty: number;
      pnl: number;
      fee: number;
    }
  | { kind: "skip"; reason: "insufficient_chips"; price: number }
  | { kind: "recenter"; lo: number; hi: number; reason: "escape" | "drift" };

export function newGame(price: number, qty: Size = 1_000): GameState {
  return {
    walls: null,
    qty,
    pos: 0,
    entry: 0,
    armed: true,
    balance: START_CHIPS,
    last: price,
    crossings: 0,
    escapes: 0,
    streak: 0,
    bestStreak: 0,
    fees: 0,
  };
}

/** Gap of a pair of walls, in tenths of a basis point of the bottom wall. */
export function gapOf(w: Walls): number {
  return Math.round(((w.hi - w.lo) * FEE_DENOM) / w.lo);
}

/** Walls of the given gap centred on a price. */
export function centredWalls(price: number, gap: number): Walls {
  const half = Math.round((price * gap) / FEE_DENOM / 2);
  return { lo: price - half, hi: price + half };
}

export function leashLong(w: Walls): number {
  return w.lo - Math.round((w.lo * gapOf(w) * LEASH_GAPS) / FEE_DENOM);
}

export function leashShort(w: Walls): number {
  return w.hi + Math.round((w.hi * gapOf(w) * LEASH_GAPS) / FEE_DENOM);
}

function fee(qty: number, price: number, rate: number): number {
  return Math.round((qty * price * rate) / FEE_DENOM);
}

export type WallsRefusal =
  | "bad_number"
  | "inverted"
  | "gap_too_small"
  | "gap_too_wide"
  | "price_not_between"
  | "exit_wrong_side"
  | "bad_size"
  | "insufficient_chips";

/**
 * Whether the player may set these walls now. The server calls this on every
 * wall move; the browser's own check is a convenience, never the control.
 *
 * Flat, the price has to sit strictly between the walls, or a wall would fill
 * the instant it is placed, which is a market order wearing a wall's clothes.
 * Holding a trade, only the exit wall is constrained: it must still be on the
 * far side of the price, or "moving the exit" would be closing at market.
 */
export function checkWalls(
  s: GameState,
  w: Walls,
  qty: number,
): { ok: true } | { ok: false; reason: WallsRefusal } {
  if (![w.lo, w.hi, qty].every((n) => Number.isSafeInteger(n) && n > 0)) {
    return { ok: false, reason: "bad_number" };
  }
  if (!(SIZES as readonly number[]).includes(qty)) {
    return { ok: false, reason: "bad_size" };
  }
  if (w.hi <= w.lo) return { ok: false, reason: "inverted" };
  const g = gapOf(w);
  if (g < MIN_GAP) return { ok: false, reason: "gap_too_small" };
  if (g > MAX_GAP) return { ok: false, reason: "gap_too_wide" };
  if (s.pos === 0) {
    if (!(w.lo < s.last && s.last < w.hi)) {
      return { ok: false, reason: "price_not_between" };
    }
    if (qty * w.hi > s.balance)
      return { ok: false, reason: "insufficient_chips" };
  } else if (s.pos > 0 ? w.hi <= s.last : w.lo >= s.last) {
    return { ok: false, reason: "exit_wrong_side" };
  }
  return { ok: true };
}

/**
 * Apply new walls. Size changes only while flat: changing the size of an open
 * trade is a second trade, and the game has no such move.
 */
export function setWalls(s: GameState, w: Walls, qty: Size): GameState {
  const ok = checkWalls(s, w, qty);
  if (!ok.ok) throw new Error(`walls refused: ${ok.reason}`);
  return {
    ...s,
    walls: { ...w },
    qty: s.pos === 0 ? qty : s.qty,
    armed: s.pos === 0 ? true : s.armed,
  };
}

/** Take the walls down. Only while flat: an open trade keeps its exit and leash. */
export function clearWalls(s: GameState): GameState {
  if (s.pos !== 0) throw new Error("cannot clear walls while holding a trade");
  return { ...s, walls: null };
}

/**
 * One traded price. Returns the new state and what happened.
 *
 * Exactly one thing can happen per price, which is the honest reading of a
 * single trade: it either touched a wall or it did not. A minute that touched
 * both walls is expressed by the caller as two prices, in the order that is
 * worse for the player (see orderSegment).
 */
export function step(
  s0: GameState,
  price: number,
): { state: GameState; events: GameEvent[] } {
  if (!Number.isSafeInteger(price) || price <= 0) {
    throw new Error(`bad price: ${price}`);
  }
  const s: GameState = { ...s0, last: price };
  const events: GameEvent[] = [];
  const w = s.walls;
  if (!w) return { state: s, events };

  if (s.pos === 0) {
    if (!s.armed) {
      if (w.lo < price && price < w.hi) s.armed = true;
      return { state: s, events };
    }
    const side: 0 | 1 | -1 = price <= w.lo ? 1 : price >= w.hi ? -1 : 0;
    if (side !== 0) {
      const px = side > 0 ? w.lo : w.hi;
      if (s.qty * px > s.balance) {
        // Disarm, so a price sitting on the wall reports this once rather
        // than on every trade until the player notices.
        s.armed = false;
        events.push({ kind: "skip", reason: "insufficient_chips", price });
        return { state: s, events };
      }
      const f = fee(s.qty, px, MAKER_FEE);
      s.pos = side;
      s.entry = px;
      s.balance -= f;
      s.fees += f;
      events.push({ kind: "open", side, price: px, qty: s.qty, fee: f });
      return { state: s, events };
    }
    return { state: s, events };
  }

  // Holding. The leash is checked before the exit: a price can only be on one
  // side, so this order matters only for a degenerate wall, and there the loss
  // is the answer that cannot flatter the player.
  const side = s.pos;
  const stop = side > 0 ? leashLong(w) : leashShort(w);
  const hitStop = side > 0 ? price <= stop : price >= stop;
  const exit = side > 0 ? w.hi : w.lo;
  const hitExit = side > 0 ? price >= exit : price <= exit;

  if (hitStop) {
    // The leash is a market order: it fills at the trade that crossed it, which
    // can be worse than the line. Never at the line itself — that would be
    // pricing a stop off a level nobody traded at.
    const f = fee(s.qty, price, TAKER_FEE);
    const pnl = side * s.qty * (price - s.entry) - f;
    s.balance += side * s.qty * (price - s.entry) - f;
    s.fees += f;
    s.escapes += 1;
    s.streak = 0;
    events.push({
      kind: "escape",
      side,
      price,
      entry: s.entry,
      qty: s.qty,
      pnl,
      fee: f,
    });
    s.pos = 0;
    s.entry = 0;
    s.walls = centredWalls(price, gapOf(w));
    s.armed = true;
    events.push({
      kind: "recenter",
      lo: s.walls.lo,
      hi: s.walls.hi,
      reason: "escape",
    });
    return { state: s, events };
  }
  if (hitExit) {
    // A resting order fills at its own price, never better: the exit wall.
    const f = fee(s.qty, exit, MAKER_FEE);
    const pnl = side * s.qty * (exit - s.entry) - f;
    s.balance += side * s.qty * (exit - s.entry) - f;
    s.fees += f;
    s.crossings += 1;
    s.streak += 1;
    s.bestStreak = Math.max(s.bestStreak, s.streak);
    events.push({
      kind: "cross",
      side,
      price: exit,
      entry: s.entry,
      qty: s.qty,
      pnl,
      fee: f,
    });
    s.pos = 0;
    s.entry = 0;
    s.armed = false;
    return { state: s, events };
  }
  return { state: s, events };
}

/**
 * Flat walls left behind by a price that ran away: follow it, so a player who
 * walked off does not come back to walls nobody can reach. Only while flat and
 * only once the price is past where the leash would have been.
 */
export function followIfStranded(s: GameState): {
  state: GameState;
  events: GameEvent[];
} {
  const w = s.walls;
  if (!w || s.pos !== 0) return { state: s, events: [] };
  if (s.last >= leashLong(w) && s.last <= leashShort(w))
    return { state: s, events: [] };
  const walls = centredWalls(s.last, gapOf(w));
  return {
    state: { ...s, walls, armed: true },
    events: [{ kind: "recenter", lo: walls.lo, hi: walls.hi, reason: "drift" }],
  };
}

/**
 * The order in which a stretch of trading reached its high and its low, chosen
 * to be the WORSE one for the player. A minute candle says the price touched
 * both, not which first; guessing the friendly order would turn a stop-out into
 * a win on paper, which is the one error a leaderboard must never contain.
 *
 * Holding long, the low comes first (the leash before the exit). Holding short,
 * the high. Flat, the nearer extreme first, since that is the wall a moving
 * price meets first.
 */
export function orderSegment(
  s: GameState,
  seg: { hi: number; lo: number; close: number },
): number[] {
  let first: number;
  let second: number;
  if (s.pos > 0) [first, second] = [seg.lo, seg.hi];
  else if (s.pos < 0) [first, second] = [seg.hi, seg.lo];
  else if (Math.abs(seg.hi - s.last) <= Math.abs(s.last - seg.lo))
    [first, second] = [seg.hi, seg.lo];
  else [first, second] = [seg.lo, seg.hi];
  return [first, second, seg.close];
}

/**
 * Run a stretch of trading through the game: its two extremes in the order
 * that is worse for the player, then where it closed. The order is decided from
 * the state the stretch started in, because that is the position the player was
 * actually exposed to while it traded.
 */
export function applySegment(
  s0: GameState,
  seg: { hi: number; lo: number; close: number },
): { state: GameState; events: GameEvent[] } {
  let s = s0;
  const events: GameEvent[] = [];
  for (const p of orderSegment(s0, seg)) {
    const r = step(s, p);
    s = r.state;
    events.push(...r.events);
  }
  const f = followIfStranded(s);
  return { state: f.state, events: [...events, ...f.events] };
}

/** Open P&L at a price, in micro-chips, before the closing fee. */
export function openPnl(s: GameState, price: number): number {
  return s.pos === 0 ? 0 : s.pos * s.qty * (price - s.entry);
}
