import { PER_SIDE_FEE_BPS } from "./exit";

// ---------------------------------------------------------------------------
// SEGUNDA COTA — a second measurement of the same level.
//
// A cota is a surveyed elevation mark. A surveyor does not trust one: they shoot
// it again from a second station and see whether the numbers close. Everything
// in this app that keeps a hunter safe — max notional, trades per day, daily
// loss, never close at a loss — is currently measured from ONE station, and it
// is the venue being traded on. Perpl quotes the price, Perpl marks the
// position, Perpl's numbers decide whether the leash has been breached.
//
// Kuru's MON/USDC order book is the second station. Same asset, same chain,
// independent book, and roughly fifty times tighter: measured 2026-09-20 over
// six samples two minutes apart, Perpl's spread ran 13-21 bps against Kuru's
// 3-7 bps.
//
// WHAT THOSE SAMPLES SHOWED, and why this is not paranoia. Perpl's MON mid sat
// ABOVE Kuru spot in all six: +15.1, +15.5, +5.1, +21.8, +10.0, +26.1 bps.
// Never below. That is a persistent premium — people paying up for leveraged
// long exposure with nobody arbitraging it back across a $78k book — and it is
// completely invisible from Perpl's own screen. An agent opening a long there
// pays the premium on top of ~8.5 bps of spread and 8.9 bps of fee, against a
// take-profit target of 100 bps.
//
// THE CHECK IS DIRECTIONAL, which is the part that makes it useful rather than
// merely noisy. A rich perp is bad for a BUYER and good for a SELLER. Gating on
// |divergence| would refuse the trades that the dislocation favours, which is
// backwards. So this measures ADVERSE divergence only: how far the price moved
// against the side being opened.
// ---------------------------------------------------------------------------

/** One venue's two-sided quote. Mids are derived, never supplied. */
export interface Book {
  bidUsd: number;
  askUsd: number;
}

export function mid(book: Book): number {
  return (book.bidUsd + book.askUsd) / 2;
}

/**
 * Signed divergence of the perp against spot, in basis points.
 *
 * Positive = the perp is RICH (trading above spot). Negative = cheap. Returns
 * null rather than a number when either book is unusable — a divergence
 * computed from a zero or a NaN is worse than no reading, because it looks like
 * agreement.
 */
export function divergenceBps(perp: Book, spot: Book): number | null {
  const p = mid(perp);
  const s = mid(spot);
  if (!Number.isFinite(p) || !Number.isFinite(s) || p <= 0 || s <= 0) {
    return null;
  }
  return ((p - s) / s) * 10_000;
}

/**
 * How far the divergence runs AGAINST opening this side.
 *
 * A long buys the perp, so a rich perp hurts it. A short sells, so a rich perp
 * helps. Positive here always means "worse for this trade", whichever way it is
 * facing.
 */
export function adverseBps(
  direction: "long" | "short",
  divBps: number,
): number {
  return direction === "long" ? divBps : -divBps;
}

export interface SegundaPolicy {
  /**
   * Refuse to open when the adverse divergence reaches this.
   *
   * Defaults to the take-profit threshold rather than a number picked by feel.
   * The reasoning: if the price is already dislocated by as much as the whole
   * move being played for, the trade is being opened into the target. A
   * tighter bound would refuse the ordinary 5-26 bps basis measured above and
   * the agent would simply never trade; a looser one stops catching anything.
   */
  maxAdverseBps: number;
  /**
   * What to do when Kuru cannot be read at all.
   *
   * Defaults to refusing. That is deliberately the inconvenient choice: it
   * means a Kuru outage stops the agent. The alternative is to fall back to
   * trusting one venue silently, which is the exact condition this module
   * exists to end — and a safety check that disables itself when its data is
   * missing is not a safety check. A refusal here is normal operation, the
   * same way the swap desk halting on a stale oracle is.
   */
  requireSecondSource: boolean;
}

export const DEFAULT_SEGUNDA_POLICY: SegundaPolicy = {
  maxAdverseBps: 100,
  requireSecondSource: true,
};

export type SegundaVerdict =
  | { ok: true; divergenceBps: number; adverseBps: number }
  | { ok: false; reason: string; divergenceBps: number | null };

/**
 * Should the agent open this side right now?
 *
 * `spot` is null when Kuru gave us nothing — an outage, a rate limit, an empty
 * book. The policy decides, and it is stated out loud in the reason so a hunter
 * reading the decision log can tell "the price was bad" from "we could not
 * check".
 */
export function segundaVerdict(args: {
  direction: "long" | "short";
  perp: Book;
  spot: Book | null;
  policy?: SegundaPolicy;
}): SegundaVerdict {
  const policy = args.policy ?? DEFAULT_SEGUNDA_POLICY;

  if (args.spot === null) {
    return policy.requireSecondSource
      ? {
          ok: false,
          reason:
            "no second price source — Kuru's book could not be read, so Perpl's price cannot be checked against anything",
          divergenceBps: null,
        }
      : { ok: true, divergenceBps: 0, adverseBps: 0 };
  }

  const div = divergenceBps(args.perp, args.spot);
  if (div === null) {
    return {
      ok: false,
      reason: "a book quoted a price that is not a number",
      divergenceBps: null,
    };
  }

  const adverse = adverseBps(args.direction, div);
  if (adverse >= policy.maxAdverseBps) {
    return {
      ok: false,
      reason: `perp is ${adverse.toFixed(1)} bps against this ${args.direction} versus Kuru spot, at or past the ${policy.maxAdverseBps} bps limit`,
      divergenceBps: div,
    };
  }
  return { ok: true, divergenceBps: div, adverseBps: adverse };
}

/**
 * Is spot the cheaper way to get this exposure right now?
 *
 * The comparison a hunter actually cares about: what the perp costs to enter
 * (its own half-spread, plus the taker+builder fee, plus whatever premium it is
 * carrying) against what the same exposure costs on Kuru's book (half its
 * spread, at zero fees).
 *
 * This is NOT a claim that spot substitutes for a perp. There is no leverage on
 * spot and the agent cannot manage it under the leash, because the hunter signs
 * it themselves. It answers one narrow question — which is cheaper to get into
 * — and the UI has to say the rest.
 */
export function spotIsCheaperBps(args: {
  direction: "long" | "short";
  perp: Book;
  spot: Book;
}): number | null {
  const div = divergenceBps(args.perp, args.spot);
  if (div === null) return null;
  const perpHalfSpreadBps =
    ((args.perp.askUsd - args.perp.bidUsd) / 2 / mid(args.perp)) * 10_000;
  const spotHalfSpreadBps =
    ((args.spot.askUsd - args.spot.bidUsd) / 2 / mid(args.spot)) * 10_000;
  if (
    !Number.isFinite(perpHalfSpreadBps) ||
    !Number.isFinite(spotHalfSpreadBps)
  ) {
    return null;
  }
  const perpCost =
    perpHalfSpreadBps + PER_SIDE_FEE_BPS + adverseBps(args.direction, div);
  // Kuru's MON/USDC book is 0 bps taker and maker, so the spread is the cost.
  const spotCost = spotHalfSpreadBps;
  return perpCost - spotCost;
}
