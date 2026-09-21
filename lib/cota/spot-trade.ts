import type { KuruQuote } from "./kuru";

// ---------------------------------------------------------------------------
// The decisions a spot trade makes, separated from the machinery that signs it.
//
// This exists because I put all of it inline in a React component first, and
// then a trade reverted on a phone and there was no way to ask any of it a
// question. Retry policy, gas padding, what counts as "received", what a
// failure should SAY — every one of those is a rule, and a rule with no test is
// a guess that happens to be written down.
//
// Nothing here touches the network or a wallet. The page keeps the sending; it
// keeps none of the deciding.
// ---------------------------------------------------------------------------

/**
 * Gas limit for a Kuru route.
 *
 * Monad charges the WHOLE limit on a revert and refunds nothing, which inverts
 * the usual advice. Estimating tightly does not save gas — it buys a failed
 * transaction at full price. Every send of this route that has actually worked
 * used ~900k, so that is a floor rather than a target, with headroom over any
 * estimate that comes in above it.
 */
export const GAS_FLOOR = 900_000n;

export function gasFor(estimate: bigint | null): bigint {
  if (estimate === null || estimate <= 0n) return GAS_FLOOR;
  const padded = (estimate * 3n) / 2n;
  return padded > GAS_FLOOR ? padded : GAS_FLOOR;
}

/**
 * What actually arrived, from two balance readings.
 *
 * Never the quote. A quote is a prediction and the chain is the fact, and on a
 * native-token buy the difference is the gas the trade itself burned — which
 * the hunter really did pay, so reporting the quote would overstate what they
 * got.
 *
 * Clamped at zero: on a small MON buy the gas can exceed the MON received, and
 * a negative "you received" is a number nobody can act on.
 */
export function received(before: bigint, after: bigint): bigint {
  return after > before ? after - before : 0n;
}

export type TradeOutcome =
  | { kind: "sent"; hash: `0x${string}` }
  | { kind: "simulation-failed" }
  | { kind: "reverted"; hash: `0x${string}` };

/**
 * Should another route be tried after this outcome?
 *
 * Both failures are worth retrying and for the same reason: Kuru's router
 * returns a different path per quote, and the one that just failed is not the
 * one the next request will hand back. Measured within a single minute with
 * balances and allowances unchanged, four sizes alternated between executing
 * and reverting.
 *
 * A revert is retried as hard as a failed simulation. The first version of this
 * threw on the first revert while identical retry logic sat one branch away —
 * so a hunter saw a dead end on a trade that would have worked on the next tap.
 */
export function shouldRetry(
  outcome: TradeOutcome,
  attempt: number,
  max: number,
): boolean {
  if (outcome.kind === "sent") return false;
  return attempt + 1 < max;
}

export interface TradeFailure {
  /** What the hunter reads. */
  message: string;
  /** The reverted transaction, when there is one to look at. */
  hash: `0x${string}` | null;
}

/**
 * What to say when no route executed.
 *
 * The two cases are genuinely different and must not collapse into one word.
 * "Nothing would simulate" means Kuru never offered a workable path and there
 * is nothing on chain to inspect. "It reverted" means a transaction exists,
 * cost gas, and can be opened on the explorer — and throwing that hash away is
 * what turned a diagnosable failure into "it just says reverted".
 */
export function explainFailure(
  lastRevert: `0x${string}` | null,
  words: { noRoute: string; revertedTx: string },
): TradeFailure {
  if (lastRevert === null) {
    return { message: words.noRoute, hash: null };
  }
  return {
    message: `${words.revertedTx} ${lastRevert.slice(0, 10)}…`,
    hash: lastRevert,
  };
}

/**
 * Is this quote worth signing?
 *
 * Guards the one claim the screen makes out loud. `requireOrderBook` is off by
 * default because refusing a pool route would hand the hunter a worse price to
 * protect a label — but the caller can demand the book when the label is the
 * point, and the answer comes from the calldata rather than from hope.
 */
export function quoteAcceptable(
  q: Pick<KuruQuote, "output" | "minOut" | "usesOrderBook">,
  opts: { requireOrderBook?: boolean } = {},
): boolean {
  if (q.output <= 0n) return false;
  // A minOut above the quote is incoherent — it can only ever revert.
  if (q.minOut > q.output) return false;
  if (opts.requireOrderBook && !q.usesOrderBook) return false;
  return true;
}
