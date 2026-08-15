// TURBO credit issuance — the pure half.
//
// A cache find pays CREDIT, not MON: WMON-wei denominated, non-withdrawable, a
// discount against a TurboCohort subscription. Nothing here touches the
// database, the clock or the network, for the same reason validateClaim does
// not: a credit entry must be recomputable from stored rows, or the ledger
// cannot be audited after the fact.
//
// Everything is `bigint`. Never `number` — 1e18 wei does not survive a double,
// and a rounding error in this file is a rounding error in someone's balance.
// The DB columns are `Decimal(78, 0)`; the route converts at the boundary with
// lib/wei.ts and hands this module bigints.
//
// WHAT IS *NOT* HERE, DELIBERATELY: the ceilings. `budgetAllows` and
// `findCapAllows` below are the same predicates the route enforces, but they
// are documentation and unit-test surface, NOT the enforcement. Enforcement is
// a conditional `UPDATE ... WHERE current + delta <= ceiling` whose
// affected-row count is checked inside the transaction that writes the Find.
// A predicate evaluated in application code is a read-then-write: K concurrent
// claims all observe the same total, all return true, and the hunt overspends
// by (K-1) rewards. Keep these two facts in sync — the SQL is authoritative.

/** Mirrors the `CreditReason` enum in prisma/schema.prisma. */
export const CREDIT_REASON_CACHE_FIND = "CACHE_FIND";

export interface CreditEntry {
  reason: typeof CREDIT_REASON_CACHE_FIND;
  /** Signed. Positive for a find; the ledger's negative entries are admin-only. */
  amountWei: bigint;
  /** Balance immediately AFTER this entry, so the ledger audits without a replay. */
  balanceAfterWei: bigint;
}

/**
 * The ledger entry and resulting balance for one accepted find.
 *
 * Returns `null` when the cache pays nothing. A zero-reward cache is a legal
 * configuration (a landmark with no credit attached), and a find on one is
 * still a find — but an append-only ledger should not accumulate rows that
 * move no value, because those rows are what a human scans during a dispute.
 *
 * Throws on a negative reward or a negative starting balance. Both are
 * impossible if the DB constraints hold, which is exactly why they are worth
 * asserting: reaching this function with one means something upstream is
 * already wrong, and issuing credit anyway would launder the bug into a
 * balance.
 */
export function creditForFind(
  balanceBeforeWei: bigint,
  rewardCreditWei: bigint,
): CreditEntry | null {
  if (rewardCreditWei < 0n) {
    throw new RangeError("negative cache reward");
  }
  if (balanceBeforeWei < 0n) {
    throw new RangeError("negative starting credit balance");
  }
  if (rewardCreditWei === 0n) return null;

  return {
    reason: CREDIT_REASON_CACHE_FIND,
    amountWei: rewardCreditWei,
    balanceAfterWei: balanceBeforeWei + rewardCreditWei,
  };
}

/**
 * Would issuing `rewardWei` keep the hunt within its credit budget?
 *
 * `budgetWei === 0` means "no ceiling configured", matching
 * `Hunt.budgetCreditWei`'s default and the `("budgetCreditWei" = 0 OR ...)`
 * arm of the SQL. Stated as the ACCEPT condition so a NaN-equivalent (there is
 * no NaN in bigint, but a negative reward is the analogue) cannot pass.
 */
export function budgetAllows(
  spentWei: bigint,
  rewardWei: bigint,
  budgetWei: bigint,
): boolean {
  if (rewardWei < 0n) return false;
  if (budgetWei === 0n) return true;
  return spentWei + rewardWei <= budgetWei;
}

/**
 * Would one more find keep the player under the per-hunt cap?
 *
 * `maxFindsPerPlayer === 0` disables the cap, matching the schema default and
 * the `(${max} = 0 OR "findCount" + 1 <= ${max})` arm of the SQL.
 */
export function findCapAllows(
  currentFindCount: number,
  maxFindsPerPlayer: number,
): boolean {
  if (!Number.isInteger(currentFindCount) || currentFindCount < 0) return false;
  if (!Number.isInteger(maxFindsPerPlayer) || maxFindsPerPlayer < 0) {
    return false;
  }
  if (maxFindsPerPlayer === 0) return true;
  return currentFindCount + 1 <= maxFindsPerPlayer;
}
