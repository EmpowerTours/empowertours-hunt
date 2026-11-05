// ---------------------------------------------------------------------------
// Haz Mercado: the quote-and-take game against the bot.
//
// One player QUOTES two walls around MON's price ("I buy at the bottom, I sell
// at the top"); the other TAKES one of them or passes. Roles swap every round,
// ten rounds a match. A trade is settled on the close of Perpl's real MON
// one-minute candle.
//
// WHICH MINUTE SETTLES. A trade locked at any moment during minute k settles on
// the close of minute k+1. The taker therefore never sees a second of the
// settling minute before committing: at least sixty seconds of price nobody has
// seen yet, however late in a minute they click.
//
// PIPELINED. The next round opens as soon as a trade is locked, so a player is
// deciding round 3 while round 2's minute trades. At most MAX_PENDING trades
// wait at once, which keeps a match near one round a minute.
//
// POINTS are tenths of a basis point of the reference price (the price when
// the quote was made), so 10 = 0.01%. Zero-sum: whatever the taker wins the
// quoter loses, so the bot's score is always minus the player's.
//
// Pure: no clock, no network, no randomness of its own (the caller passes rng).
// ---------------------------------------------------------------------------

export const ROUNDS = 10;
export const PASSES = 2;
export const QUOTE_MS = 20_000;
export const TAKE_MS = 15_000;
export const MINUTE = 60_000;
/** Perpl's candle for a minute is final a moment after the minute ends. */
export const SETTLE_GRACE_MS = 5_000;
export const MAX_PENDING = 2;
export const MIN_SPREAD_BPS = 2;
export const MAX_SPREAD_BPS = 60;
/** Letting the clock run out with no pass left: 5.0 points to the other side. */
export const TIMEOUT_PENALTY = 50;

export type Who = "you" | "bot";
export type Action = "buy" | "sell" | "pass" | "timeout";

export interface Round {
  n: number;
  quoter: Who;
  openedAt: number;
  /** Price the quote was made against. */
  ref: number | null;
  bid: number | null;
  ask: number | null;
  quotedAt: number | null;
  action: Action | null;
  lockedAt: number | null;
  /** Open time of the candle whose close settles a buy or sell. */
  settleT: number | null;
  close: number | null;
  /** Points to the player once settled (tenths of a bp); the bot gets minus this. */
  you: number | null;
}

export interface Match {
  rounds: Round[];
  passes: { you: number; bot: number };
  startedAt: number;
}

export interface Market {
  /** Latest traded price, or null when the feed has nothing. */
  price: number | null;
  /** Recent one-minute closes of traded minutes, oldest first. */
  closes: number[];
}

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  n: number;
}

export type Rng = () => number;

export class GameError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "GameError";
  }
}

export function newMatch(now: number): Match {
  return { rounds: [], passes: { you: PASSES, bot: PASSES }, startedAt: now };
}

export const quoterOf = (n: number): Who => (n % 2 === 1 ? "bot" : "you");

export function deadline(r: Round): number | null {
  if (r.lockedAt !== null) return null;
  if (r.quoter === "you") return r.openedAt + QUOTE_MS;
  return (r.quotedAt ?? r.openedAt) + TAKE_MS;
}

export const current = (m: Match): Round | null =>
  m.rounds.length && m.rounds[m.rounds.length - 1].lockedAt === null
    ? m.rounds[m.rounds.length - 1]
    : null;

export const pending = (m: Match): Round[] =>
  m.rounds.filter((r) => r.lockedAt !== null && r.you === null);

export const score = (m: Match): number =>
  m.rounds.reduce((s, r) => s + (r.you ?? 0), 0);

export const finished = (m: Match): boolean =>
  m.rounds.length === ROUNDS && m.rounds.every((r) => r.you !== null);

/** The settling minute for a trade locked at `t`: the one after it. */
export const settleMinute = (t: number): number =>
  Math.floor(t / MINUTE) * MINUTE + MINUTE;

export function spreadLimits(ref: number): { min: number; max: number } {
  return {
    min: Math.max(2, Math.ceil((ref * MIN_SPREAD_BPS) / 10_000)),
    max: Math.max(4, Math.floor((ref * MAX_SPREAD_BPS) / 10_000)),
  };
}

export type QuoteRefusal =
  | "bad_number"
  | "inverted"
  | "price_not_between"
  | "spread_too_small"
  | "spread_too_wide";

export function checkQuote(
  ref: number,
  bid: number,
  ask: number,
): QuoteRefusal | null {
  if (![ref, bid, ask].every(Number.isSafeInteger) || bid <= 0)
    return "bad_number";
  if (bid >= ask) return "inverted";
  if (bid >= ref || ask <= ref) return "price_not_between";
  const { min, max } = spreadLimits(ref);
  if (ask - bid < min) return "spread_too_small";
  if (ask - bid > max) return "spread_too_wide";
  return null;
}

/** Taker's result in tenths of a bp of the reference price. */
export function takerPoints(r: Round, close: number): number {
  if (r.ref === null || r.bid === null || r.ask === null) return 0;
  if (r.action === "buy") return Math.round(((close - r.ask) * 1e5) / r.ref);
  if (r.action === "sell") return Math.round(((r.bid - close) * 1e5) / r.ref);
  return 0;
}

// ---------- the bot ----------
// It reads the last few minutes like a player would: a trend (where the last
// three closes went) and how much a minute usually moves. It is meant to be
// beatable by someone who reads the chart and the bot's lean, not to be smart.

function read(closes: number[], ref: number) {
  const c = closes.length ? closes : [ref];
  const n = c.length;
  const trend = n >= 4 ? (0.7 * (c[n - 1] - c[n - 4])) / 3 : 0;
  const moves: number[] = [];
  for (let i = Math.max(1, n - 15); i < n; i++)
    moves.push(Math.abs(c[i] - c[i - 1]));
  moves.sort((a, b) => a - b);
  const median = moves.length ? moves[Math.floor(moves.length / 2)] : 0;
  return { trend, vol: Math.max(1, median) };
}

export function botQuote(
  ref: number,
  closes: number[],
  rng: Rng,
): { bid: number; ask: number } {
  const { trend, vol } = read(closes, ref);
  const { min, max } = spreadLimits(ref);
  const half = Math.min(max / 2, Math.max(min / 2, vol * (1 + rng()) + 1));
  // The lean never pushes a wall across the price: both walls straddle it.
  const room = Math.max(0, half - 1);
  const lean = Math.max(
    -room,
    Math.min(room, 0.8 * trend + (rng() - 0.5) * vol),
  );
  const bid = Math.min(ref - 1, Math.round(ref + lean - half));
  let ask = Math.max(ref + 1, Math.round(ref + lean + half));
  if (ask - bid < min) ask = bid + min;
  if (ask - bid > max) ask = bid + max;
  return { bid, ask };
}

export function botTake(
  r: Round,
  closes: number[],
  passesLeft: number,
  rng: Rng,
): "buy" | "sell" | "pass" {
  const ref = r.ref ?? 0;
  const { trend, vol } = read(closes, ref);
  const fair = ref + trend + (rng() - 0.5) * vol * 0.5;
  const eBuy = fair - (r.ask ?? 0);
  const eSell = (r.bid ?? 0) - fair;
  const best = eBuy >= eSell ? "buy" : "sell";
  if (Math.max(eBuy, eSell) < -1.5 * vol && passesLeft > 0) return "pass";
  return best;
}

// ---------- moves ----------

function clone(m: Match): Match {
  return {
    rounds: m.rounds.map((r) => ({ ...r })),
    passes: { ...m.passes },
    startedAt: m.startedAt,
  };
}

function lock(m: Match, r: Round, action: Action, at: number) {
  r.action = action;
  r.lockedAt = at;
  if (action === "buy" || action === "sell") {
    r.settleT = settleMinute(at);
    return;
  }
  if (action === "pass") {
    if (r.quoter === "you") m.passes.bot--;
    else m.passes.you--;
    r.you = 0;
    return;
  }
  // timeout: only the player can run out of time
  r.you = -TIMEOUT_PENALTY;
}

/** The close that settles minute `t`, if Perpl has it final. */
export function closeFor(
  t: number,
  candles: Candle[],
  now: number,
): number | null {
  if (now < t + MINUTE + SETTLE_GRACE_MS) return null;
  const exact = candles.find((c) => c.t === t);
  if (exact) return exact.c;
  // No candle for that minute: nobody traded, so the price is the last one
  // before it, as long as we can see the feed has moved past it.
  if (!candles.some((c) => c.t > t)) return null;
  let last: Candle | null = null;
  for (const c of candles) if (c.t < t && (!last || c.t > last.t)) last = c;
  return last ? last.c : null;
}

/**
 * Bring a match up to `now`: settle trades whose minute has closed, time out a
 * decision whose clock ran out, and open the next round when there is room.
 */
export function tick(
  match: Match,
  now: number,
  market: Market,
  candles: Candle[],
  rng: Rng,
): { match: Match; changed: boolean } {
  const m = clone(match);
  let changed = false;

  for (const r of pending(m)) {
    if (r.settleT === null) continue;
    const close = closeFor(r.settleT, candles, now);
    if (close === null) continue;
    r.close = close;
    const t = takerPoints(r, close);
    r.you = r.quoter === "bot" ? t : -t;
    changed = true;
  }

  const cur = current(m);
  if (cur) {
    const d = deadline(cur);
    if (d !== null && now >= d) {
      if (cur.quoter === "bot" && m.passes.you > 0) lock(m, cur, "pass", d);
      else lock(m, cur, "timeout", d);
      changed = true;
    }
  }

  if (
    !current(m) &&
    m.rounds.length < ROUNDS &&
    pending(m).length < MAX_PENDING &&
    market.price !== null
  ) {
    const n = m.rounds.length + 1;
    const r: Round = {
      n,
      quoter: quoterOf(n),
      openedAt: now,
      ref: null,
      bid: null,
      ask: null,
      quotedAt: null,
      action: null,
      lockedAt: null,
      settleT: null,
      close: null,
      you: null,
    };
    if (r.quoter === "bot") {
      const q = botQuote(market.price, market.closes, rng);
      r.ref = market.price;
      r.bid = q.bid;
      r.ask = q.ask;
      r.quotedAt = now;
    }
    m.rounds.push(r);
    changed = true;
  }

  return { match: m, changed };
}

/** The player quotes; the bot answers at once. */
export function quote(
  match: Match,
  now: number,
  market: Market,
  bid: number,
  ask: number,
  rng: Rng,
): Match {
  const m = clone(match);
  const r = current(m);
  if (!r || r.quoter !== "you") throw new GameError("not_your_quote");
  const d = deadline(r);
  if (d !== null && now >= d) throw new GameError("too_late");
  if (market.price === null) throw new GameError("feed_unavailable");
  const refused = checkQuote(market.price, bid, ask);
  if (refused) throw new GameError(refused);
  r.ref = market.price;
  r.bid = bid;
  r.ask = ask;
  r.quotedAt = now;
  lock(m, r, botTake(r, market.closes, m.passes.bot, rng), now);
  return m;
}

/** The player takes the bot's quote, or passes. */
export function take(
  match: Match,
  now: number,
  action: "buy" | "sell" | "pass",
): Match {
  const m = clone(match);
  const r = current(m);
  if (!r || r.quoter !== "bot") throw new GameError("not_your_take");
  const d = deadline(r);
  if (d !== null && now >= d) throw new GameError("too_late");
  if (action === "pass" && m.passes.you <= 0) throw new GameError("no_passes");
  lock(m, r, action, now);
  return m;
}
