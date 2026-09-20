// Settling a redemption on chain — the pure half.
//
// A redemption debits credit and records that months are OWED. Settling is the
// other side: the settler wallet actually pays TurboCohort so the player gets a
// real membership month. Same rules as lib/hunt/credit.ts and redeem.ts — no
// database, no clock, no network, everything `bigint` — so a settlement plan is
// recomputable from stored rows and can be audited after the fact.
//
// ## Why the settler has to wrap first
//
// `TurboCohortV7.payMonthlyFor` moves WMON with `safeTransferFrom(payer, ...)`,
// twice: the treasury fee and the pool share. The settler is funded in native
// MON, not WMON, so a settlement that does not wrap first transfers a token the
// wallet does not hold. That failure is invisible in the code — a transfer of a
// token you do not have is written exactly like one you do — and it is the same
// bug fcempowertours hit when two EPK routes charged a Safe holding 44 MON and
// 0 WMON. Wrap the SHORTFALL only; wrapping the whole cost would strand MON as
// WMON on every settlement.
//
// ## Why approval is a step and not an assumption
//
// `safeTransferFrom` spends the settler's allowance, so the cohort must be
// approved. This plans an exact-amount approval per settlement rather than one
// unlimited approval: the settler is a hot server key, and an unlimited
// allowance on a hot key is a standing withdrawal right for as long as it lives.
// The extra transaction is the price of that not being true.

/** One on-chain action. The executor performs these in order and stops on failure. */
export type SettlementStep =
  | { kind: "WRAP"; /** Native MON to convert, in wei. Never more than the shortfall. */ amountWei: bigint }
  | { kind: "APPROVE"; /** Exact allowance to grant the cohort, in wei. */ amountWei: bigint }
  | { kind: "PAY"; /** What payMonthlyFor will move, in wei. For the audit note. */ costWei: bigint };

export type SettleRefusal =
  | "cost_not_positive"
  | "insufficient_native"; // cannot even wrap the shortfall

export type SettlementPlan =
  | { ok: true; steps: SettlementStep[]; wrapWei: bigint; approveWei: bigint }
  | { ok: false; reason: SettleRefusal; shortfallWei: bigint };

export interface SettleInputs {
  /** tierPriceWei * months — what payMonthlyFor will pull from the settler. */
  costWei: bigint;
  /** Settler's current WMON balance. */
  wmonHeldWei: bigint;
  /** Settler's current WMON allowance to the cohort. */
  allowanceWei: bigint;
  /** Settler's native MON balance. */
  nativeHeldWei: bigint;
  /**
   * Native MON to leave behind for gas. Monad charges on the gas LIMIT with no
   * refund, so a plan that wraps every last wei leaves nothing to pay for the
   * wrap itself — and the failure looks like a broken settlement rather than an
   * empty tank.
   */
  gasReserveWei: bigint;
}

/**
 * What must happen on chain before this redemption is settled.
 *
 * Returns the steps in execution order. An empty-ish plan is still a plan: when
 * the settler already holds enough WMON and has enough allowance, the only step
 * is PAY.
 */
export function planSettlement(input: SettleInputs): SettlementPlan {
  const { costWei, wmonHeldWei, allowanceWei, nativeHeldWei, gasReserveWei } = input;

  if (costWei <= 0n) {
    // A zero cost is not "free" — it is a failed tier-price read upstream, and
    // settling it would mark a redemption SETTLED without paying anyone.
    return { ok: false, reason: "cost_not_positive", shortfallWei: 0n };
  }

  const wrapWei = wmonHeldWei >= costWei ? 0n : costWei - wmonHeldWei;

  if (wrapWei > 0n) {
    const spendable = nativeHeldWei > gasReserveWei ? nativeHeldWei - gasReserveWei : 0n;
    if (spendable < wrapWei) {
      return { ok: false, reason: "insufficient_native", shortfallWei: wrapWei - spendable };
    }
  }

  // Re-approve whenever the standing allowance is short. Allowances are not
  // additive across settlements: a partly-spent approval from a previous run
  // can be non-zero and still insufficient.
  const approveWei = allowanceWei >= costWei ? 0n : costWei;

  const steps: SettlementStep[] = [];
  if (wrapWei > 0n) steps.push({ kind: "WRAP", amountWei: wrapWei });
  if (approveWei > 0n) steps.push({ kind: "APPROVE", amountWei: approveWei });
  steps.push({ kind: "PAY", costWei });

  return { ok: true, steps, wrapWei, approveWei };
}

export function explainSettleRefusal(reason: SettleRefusal): string {
  switch (reason) {
    case "cost_not_positive":
      return "Tier price unavailable, so there is nothing to settle.";
    case "insufficient_native":
      return "The settler does not hold enough MON to wrap the WMON shortfall.";
  }
}
