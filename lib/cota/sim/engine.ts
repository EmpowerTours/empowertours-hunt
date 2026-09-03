// ---------------------------------------------------------------------------
// A paper book, marked against real Perpl prices and governed by a real Cota.
//
// The point of this file is what it does NOT contain. There is no key, no
// signer, no Perpl trading client — a paper account cannot reach the venue
// because nothing here knows how. And there are no ceiling checks either: every
// limit is enforced by lib/cota/enforce.ts, the same function the live runner
// calls. A player practising here is exercising the code that will one day hold
// somebody's collateral, which is the only thing that makes practice worth
// anything.
//
// Everything is a pure transition: state in, state out. No clock, no storage.
// ---------------------------------------------------------------------------

import {
  mayOpen,
  mustClose,
  utcDayKey,
  type DayState,
  type Decision,
  type EnforcedBound,
} from "../enforce";
import { USD_SCALE } from "../scale";

export type Side = "long" | "short";

export interface PaperPosition {
  market: string;
  side: Side;
  /** Notional at entry, e6 USD. */
  notionalUsdE6: bigint;
  /** Entry mark, e6 USD. */
  entryUsdE6: bigint;
  leverageX100: bigint;
  openedAt: Date;
}

export interface PaperAccount {
  /** UTC day these counters belong to; see utcDayKey. */
  dayKey: string;
  tradesToday: number;
  /** Signed: negative is down. Realised only — open risk is marked below. */
  realisedPnlUsdE6: bigint;
  positions: readonly PaperPosition[];
}

export function emptyAccount(at: Date): PaperAccount {
  return {
    dayKey: utcDayKey(at),
    tradesToday: 0,
    realisedPnlUsdE6: 0n,
    positions: [],
  };
}

/**
 * Roll the daily counters when the UTC day has turned.
 *
 * Positions deliberately survive the roll — a trade left open overnight is
 * still open, and zeroing its risk at midnight would let a bound's loss
 * ceiling be reset by waiting rather than by closing.
 */
export function rollDay(account: PaperAccount, at: Date): PaperAccount {
  const key = utcDayKey(at);
  if (key === account.dayKey) return account;
  return { ...account, dayKey: key, tradesToday: 0, realisedPnlUsdE6: 0n };
}

/**
 * Mark-to-market on one position, signed, e6 USD.
 *
 * `notional * (mark - entry) / entry`, in integers throughout. The e6 scales
 * cancel: an e6 notional times an e6 delta over an e6 entry lands back on e6.
 */
export function unrealisedPnlUsdE6(
  position: PaperPosition,
  markUsdE6: bigint,
): bigint {
  if (markUsdE6 <= 0n || position.entryUsdE6 <= 0n) return 0n;
  const delta = markUsdE6 - position.entryUsdE6;
  const move = (position.notionalUsdE6 * delta) / position.entryUsdE6;
  return position.side === "long" ? move : -move;
}

function markOf(marks: ReadonlyMap<string, bigint>, market: string): bigint {
  return marks.get(market) ?? 0n;
}

/**
 * The account expressed in the shape the enforcement layer understands.
 *
 * This is the seam. `enforce.ts` never sees a PaperPosition, and the live
 * runner will build the same DayState out of real fills — so both are judged
 * by identical arithmetic against identical fields.
 */
export function toDayState(
  account: PaperAccount,
  marks: ReadonlyMap<string, bigint>,
): DayState {
  let open = 0n;
  let unrealised = 0n;
  for (const p of account.positions) {
    open += p.notionalUsdE6;
    unrealised += unrealisedPnlUsdE6(p, markOf(marks, p.market));
  }

  const net = account.realisedPnlUsdE6 + unrealised;

  return {
    tradesToday: account.tradesToday,
    // The ceiling counts loss, so profit is not negative loss — it is zero
    // loss. Letting a winning day bank headroom against tomorrow's limit
    // would quietly widen a number the player wrote down.
    lossTodayUsdE6: net < 0n ? -net : 0n,
    openNotionalUsdE6: open,
  };
}

export interface OpenRequest {
  market: string;
  side: Side;
  notionalUsdE6: bigint;
  leverageX100: bigint;
}

export type OpenResult =
  | { ok: true; account: PaperAccount; position: PaperPosition }
  | { ok: false; decision: Decision };

/**
 * Attempt to open, subject to the bound.
 *
 * The order of operations matters: the day is rolled first (so a player who
 * comes back tomorrow gets tomorrow's allowance), the book is marked, and only
 * then is the bound consulted. Marking before asking is what lets an open
 * position's unrealised loss block a new trade.
 */
export function open(
  account: PaperAccount,
  bound: EnforcedBound,
  request: OpenRequest,
  marks: ReadonlyMap<string, bigint>,
  at: Date,
): OpenResult {
  const rolled = rollDay(account, at);
  const nowSeconds = BigInt(Math.floor(at.getTime() / 1000));
  const state = toDayState(rolled, marks);

  const decision = mayOpen(
    bound,
    state,
    {
      venue: bound.venue,
      market: request.market,
      notionalUsdE6: request.notionalUsdE6,
      leverageX100: request.leverageX100,
    },
    nowSeconds,
  );
  if (!decision.ok) return { ok: false, decision };

  const entryUsdE6 = markOf(marks, request.market);
  if (entryUsdE6 <= 0n) {
    // No price, no fill. Opening at zero would create a position whose PnL is
    // undefined and whose notional the ceiling has already been charged for.
    return {
      ok: false,
      decision: { ok: false, reason: "market_not_authorised" },
    };
  }

  const position: PaperPosition = {
    market: request.market,
    side: request.side,
    notionalUsdE6: request.notionalUsdE6,
    entryUsdE6,
    leverageX100: request.leverageX100,
    openedAt: at,
  };

  return {
    ok: true,
    position,
    account: {
      ...rolled,
      tradesToday: rolled.tradesToday + 1,
      positions: [...rolled.positions, position],
    },
  };
}

/**
 * Close one position at the current mark, banking its PnL.
 *
 * Closing is never refused. A bound limits what may be OPENED and when a book
 * must be flattened; software that could not reduce risk because a limit had
 * already been breached would be the exact opposite of a safety mechanism.
 */
export function close(
  account: PaperAccount,
  position: PaperPosition,
  marks: ReadonlyMap<string, bigint>,
  at: Date,
): PaperAccount {
  const rolled = rollDay(account, at);
  const index = rolled.positions.indexOf(position);
  if (index === -1) return rolled;

  const pnl = unrealisedPnlUsdE6(position, markOf(marks, position.market));
  const positions = rolled.positions.filter((_, i) => i !== index);

  return {
    ...rolled,
    realisedPnlUsdE6: rolled.realisedPnlUsdE6 + pnl,
    positions,
  };
}

/** Flatten everything — what the runner does when {@link mustClose} fires. */
export function closeAll(
  account: PaperAccount,
  marks: ReadonlyMap<string, bigint>,
  at: Date,
): PaperAccount {
  let next = rollDay(account, at);
  for (const position of [...next.positions]) {
    next = close(next, position, marks, at);
  }
  return next;
}

/**
 * Does the bound require this book to be flattened right now?
 *
 * Delegates outright. The paper runner and the live runner ask the same
 * question of the same function, so a limit that stops one stops the other.
 */
export function checkMustClose(
  account: PaperAccount,
  bound: EnforcedBound,
  marks: ReadonlyMap<string, bigint>,
  at: Date,
): Decision {
  const rolled = rollDay(account, at);
  return mustClose(
    bound,
    toDayState(rolled, marks),
    BigInt(Math.floor(at.getTime() / 1000)),
  );
}

/** Equity change so far today, for display. Signed, e6 USD. */
export function netPnlUsdE6(
  account: PaperAccount,
  marks: ReadonlyMap<string, bigint>,
): bigint {
  let unrealised = 0n;
  for (const p of account.positions) {
    unrealised += unrealisedPnlUsdE6(p, markOf(marks, p.market));
  }
  return account.realisedPnlUsdE6 + unrealised;
}

/** Human-readable USD, for the screen. */
export function formatUsdE6(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / USD_SCALE;
  const cents = (abs % USD_SCALE) / 10_000n;
  return `${negative ? "-" : ""}$${whole}.${cents.toString().padStart(2, "0")}`;
}
