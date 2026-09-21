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
  | {
      kind: "WRAP";
      /** Native MON to convert, in wei. Never more than the shortfall. */ amountWei: bigint;
    }
  | {
      kind: "APPROVE";
      /** Exact allowance to grant the cohort, in wei. */ amountWei: bigint;
    }
  | {
      kind: "PAY";
      /** What payMonthlyFor will move, in wei. For the audit note. */ costWei: bigint;
    };

export type SettleRefusal =
  | "cost_not_positive"
  | "price_moved" // live tier price no longer matches what the credit bought
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
  const { costWei, wmonHeldWei, allowanceWei, nativeHeldWei, gasReserveWei } =
    input;

  if (costWei <= 0n) {
    // A zero cost is not "free" — it is a failed tier-price read upstream, and
    // settling it would mark a redemption SETTLED without paying anyone.
    return { ok: false, reason: "cost_not_positive", shortfallWei: 0n };
  }

  const wrapWei = wmonHeldWei >= costWei ? 0n : costWei - wmonHeldWei;

  if (wrapWei > 0n) {
    const spendable =
      nativeHeldWei > gasReserveWei ? nativeHeldWei - gasReserveWei : 0n;
    if (spendable < wrapWei) {
      return {
        ok: false,
        reason: "insufficient_native",
        shortfallWei: wrapWei - spendable,
      };
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
    case "price_moved":
      return "The tier price has moved since this credit was spent; settling now would pay a different amount than the player was charged.";
    case "insufficient_native":
      return "The settler does not hold enough MON to wrap the WMON shortfall.";
  }
}

// ---------------------------------------------------------------------------
// Does today's price still match what this credit bought?
//
// Settlement deliberately re-reads the live tier price rather than trusting the
// row, because the cohort charges today's price and paying a stale one would
// under- or over-pay the contract. That is right. What was missing is the other
// half: nothing compared the re-read price against what the player was actually
// debited.
//
// `settleRedemption` parsed `costCreditWei` off the row and then never used it
// — the plan was built from `dueWei` alone. So an admin repricing between
// redeem and settle moved the settler's payment with nothing objecting. The
// concrete case: TurboCohortV7 was set to 0.001 WMON for a test and restored to
// 139 WMON. A row created in between would have settled at 139,000x what its
// credit was priced at, and the only thing standing in the way was the settler
// not happening to hold that much WMON. An empty wallet is not a control.
//
// A BAND, not equality. A modest repricing is legitimate and should still
// settle; the failure this catches is an order-of-magnitude gap. Beyond the
// band it fails loudly and leaves the row PENDING for a human, which is the
// right recovery path for "somebody changed a price" — not a retry, and
// certainly not paying it.
// ---------------------------------------------------------------------------

/** How far the live price may sit from the credited price before refusing. */
export const PRICE_DRIFT_TOLERANCE_BPS = 2_500; // ±25%

export type PriceDrift =
  { ok: true; driftBps: number } | { ok: false; driftBps: number };

/**
 * @param creditedWei what the player was debited for, in wei (row.costCreditWei)
 * @param dueWei      what the settler is about to pay, in wei (livePrice x months)
 */
export function checkPriceDrift(
  creditedWei: bigint,
  dueWei: bigint,
  toleranceBps: number = PRICE_DRIFT_TOLERANCE_BPS,
): PriceDrift {
  // A row recording no credit cannot be compared against anything, and paying
  // real WMON for it is the exact overspend this guards. Refuse rather than
  // divide by zero or wave it through.
  if (creditedWei <= 0n)
    return { ok: false, driftBps: Number.POSITIVE_INFINITY };
  const diff =
    dueWei > creditedWei ? dueWei - creditedWei : creditedWei - dueWei;
  // Scaled before dividing: bigint division truncates, so computing the ratio
  // first would round a 24% drift to 0 and report no movement at all.
  const driftBps = Number((diff * 10_000n) / creditedWei);
  return driftBps > toleranceBps
    ? { ok: false, driftBps }
    : { ok: true, driftBps };
}
