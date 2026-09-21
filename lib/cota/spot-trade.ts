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
 * Gas limits for a Kuru route, measured rather than guessed.
 *
 * Monad charges the WHOLE limit on a revert and refunds nothing, so the limit
 * is not a ceiling you might reach — it is the price of the trade. Receipts
 * cannot tell you otherwise: `gasUsed` comes back equal to `gasLimit` on every
 * transaction, and the top frame of a callTracer trace reports the same
 * charged figure. Real consumption is only visible through `eth_estimateGas`
 * or by summing the inner call frames.
 *
 * Measured on mainnet 2026-09-20, MON/USDC both ways, 25 quotes:
 *
 *   order-book route          ~387,000      (the usual path, very stable)
 *   single-hop pool route     ~312,000
 *   three-hop pool route       622,414      (v4 + v3 + v2; the worst seen)
 *
 * That last one is not hypothetical: it is tx 0x95f14269…2bb0 re-estimated
 * against the block it actually executed from, and it agrees with the sum of
 * that transaction's own call frames. The trade was sent with a 933,621 limit,
 * so it paid 1.5x what it used — and a book route at the same limit pays 2.4x.
 *
 * Estimating against `latest` instead of the execution block moved the number
 * by 5.6%. Monad executes asynchronously — the simulation runs against state
 * roughly three blocks ahead of where the transaction lands — and crossing a
 * different set of book levels costs different gas. The 1.5x pad exists for
 * that drift and covers it about nine times over.
 */

/**
 * Used only when there is no estimate at all.
 *
 * Blind, so it must cover the heaviest route ever observed (622,414) plus
 * drift plus margin. This is deliberately close to the old unconditional
 * floor: when we cannot see, the old caution is right. It should almost never
 * fire — estimation failed on none of the 25 samples.
 */
export const GAS_FALLBACK = 950_000n;

/**
 * A sanity floor on a padded estimate, not a tax.
 *
 * The cheapest route measured pads to 467,923, so this never binds on a real
 * quote. It exists so an absurdly low estimate cannot produce a limit that
 * reverts and charges for the privilege.
 */
export const GAS_MIN = 400_000n;

/**
 * The most a single trade may ever be charged.
 *
 * Nothing measured comes near it — the worst route pads to 933,621. It bounds
 * the damage if Kuru's router returns a path unlike anything seen here, or if
 * an estimate comes back wrong in the expensive direction. At ~102 gwei this
 * caps one trade at about 0.153 MON.
 */
export const GAS_CEILING = 1_500_000n;

/**
 * The limit to send.
 *
 * The estimate leads and the constants only catch its absence or its extremes.
 * The previous version had this backwards: a flat 900,000 floor sat above every
 * padded estimate, so the estimate never once decided anything and every trade
 * paid the worst case. On a 5 MON sale that was 1.9% of notional — worse than
 * the swap desk's fee, on a screen built to beat it.
 */
export function gasFor(estimate: bigint | null): bigint {
  if (estimate === null || estimate <= 0n) return GAS_FALLBACK;
  const padded = (estimate * 3n) / 2n;
  if (padded < GAS_MIN) return GAS_MIN;
  if (padded > GAS_CEILING) return GAS_CEILING;
  return padded;
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
