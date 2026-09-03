// TURBO credit redemption — the pure half.
//
// A cache find issues credit; this is where credit stops being a number and
// becomes months of a TurboCohort subscription. Same rules as lib/hunt/credit.ts:
// no database, no clock, no network, everything `bigint`, because a redemption
// has to be recomputable from stored rows or the ledger cannot be audited.
//
// ## Why the tier price is a parameter and not a constant
//
// `TurboCohort.tierPrice(tier)` is on-chain state and the cohort can change it.
// A constant here would keep selling months at whatever the price was the day
// somebody typed it in — quietly, and in the player's favour or against them
// depending on which way it moved. The caller reads the chain and passes what
// it read; this module only does arithmetic on it.
//
// ## Whole months only
//
// Credit is described as a discount, and a discount can be partial — but a
// partial month is not settleable. The deployed TurboCohort exposes only
// `payMonthly(uint8)`, which pays for `msg.sender`; there is no
// pay-on-behalf entry point, so nobody can apply a 40%-of-a-month discount to
// somebody else's payment without a person doing arithmetic by hand. Whole
// months is the unit that can actually be honoured, and it is also the unit
// the player was promised ("14 finds is a month").

/** Mirrors the `CreditReason` enum in prisma/schema.prisma. */
export const CREDIT_REASON_REDEMPTION = "TURBO_REDEMPTION";

export interface DebitEntry {
  reason: typeof CREDIT_REASON_REDEMPTION;
  /** NEGATIVE. Redemption spends credit; the ledger stores signed amounts. */
  amountWei: bigint;
  /** Balance immediately AFTER this entry. */
  balanceAfterWei: bigint;
}

export type RedeemRefusal =
  | "no_price"
  | "not_enough_credit"
  | "months_not_positive"
  | "months_exceed_balance";

export type RedeemPlan =
  | { ok: true; months: number; costWei: bigint; debit: DebitEntry }
  | { ok: false; reason: RedeemRefusal };

/**
 * How many whole months a balance buys at this price.
 *
 * Integer division, so it truncates — which is the honest direction. Rounding
 * up would hand out a month the player has not earned, and every one of those
 * is a real subscription somebody has to pay for.
 */
export function monthsAffordable(
  balanceWei: bigint,
  tierPriceWei: bigint,
): number {
  if (tierPriceWei <= 0n) return 0;
  if (balanceWei <= 0n) return 0;
  return Number(balanceWei / tierPriceWei);
}

/**
 * Plan a redemption: what it costs, and the ledger entry that records it.
 *
 * Returns a refusal rather than throwing for anything a player can cause — an
 * empty balance and an over-ambitious request are ordinary states, not bugs,
 * and the screen needs to say which one happened.
 *
 * Throws only on a negative balance, which the database makes impossible. If
 * one ever reaches here, something upstream is already wrong and letting a
 * redemption proceed would launder that bug into a settled subscription.
 */
export function planRedemption(
  balanceWei: bigint,
  tierPriceWei: bigint,
  months: number,
): RedeemPlan {
  if (balanceWei < 0n) {
    throw new RangeError("negative credit balance");
  }
  if (tierPriceWei <= 0n) {
    // A zero price is not "free months" — it is a failed read of on-chain
    // state, and treating it as free would mint subscriptions out of nothing.
    return { ok: false, reason: "no_price" };
  }
  if (!Number.isInteger(months) || months <= 0) {
    return { ok: false, reason: "months_not_positive" };
  }

  const affordable = monthsAffordable(balanceWei, tierPriceWei);
  if (affordable === 0) {
    return { ok: false, reason: "not_enough_credit" };
  }
  if (months > affordable) {
    return { ok: false, reason: "months_exceed_balance" };
  }

  const costWei = tierPriceWei * BigInt(months);

  return {
    ok: true,
    months,
    costWei,
    debit: {
      reason: CREDIT_REASON_REDEMPTION,
      amountWei: -costWei,
      balanceAfterWei: balanceWei - costWei,
    },
  };
}

/**
 * The compensating entry that gives credit back when a redemption is voided.
 *
 * A refund is a NEW row, never an edit to the debit. The ledger is append-only
 * because a dispute is settled by reading it, and a history that can be
 * rewritten answers no question worth asking. After a void the ledger shows
 * both the spend and the return, which is what actually happened.
 */
export function refundForVoid(
  balanceBeforeWei: bigint,
  costWei: bigint,
): DebitEntry {
  if (costWei <= 0n) {
    throw new RangeError("refund of a non-positive cost");
  }
  return {
    reason: CREDIT_REASON_REDEMPTION,
    amountWei: costWei,
    balanceAfterWei: balanceBeforeWei + costWei,
  };
}

/** Human-readable refusal, for the screen a player is looking at. */
export function explainRefusal(
  reason: RedeemRefusal,
  lang: "es" | "en",
): string {
  const ES: Record<RedeemRefusal, string> = {
    no_price:
      "No se pudo leer el precio del cohorte. Intenta de nuevo en un momento.",
    not_enough_credit:
      "Todavía no te alcanza para un mes completo. Sigue caminando.",
    months_not_positive: "Elige al menos un mes.",
    months_exceed_balance: "No te alcanza para tantos meses.",
  };
  const EN: Record<RedeemRefusal, string> = {
    no_price: "Couldn't read the cohort price. Try again in a moment.",
    not_enough_credit: "Not enough for a full month yet. Keep walking.",
    months_not_positive: "Choose at least one month.",
    months_exceed_balance: "That's more months than your credit covers.",
  };
  return lang === "es" ? ES[reason] : EN[reason];
}
