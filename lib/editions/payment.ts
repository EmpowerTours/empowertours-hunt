// Did this hunter actually pay for this edition?
//
// Pure, and separate from the route, for the same reason lib/hunt/spawn.ts is:
// this is the decision that lets a licence leave the relayer, so it has to be
// answerable by replaying stored values rather than by trusting that the code
// did the right thing on the night.
//
// ## Why the hunter signs a plain transfer and nothing else
//
// A hunter holds real MON — payouts land in their own wallet, there is no
// internal balance to debit. So they CAN pay, and they can afford the gas: a
// native transfer is ~21k, about $0.00005 on Monad.
//
// The alternative was letting them buy at the venue themselves: wrap MON to
// WMON, APPROVE the SalesController, then purchase. Three transactions and a
// standing allowance on a wallet belonging to someone who does not know what
// an allowance is — and the v3 audit's critical finding was bounded by exactly
// "the victim's outstanding WMON allowance". One transfer to the relayer costs
// the hunter less and creates nothing that can be drained later.
//
// The cost is a short trust window: the money has moved and the licence has
// not arrived yet. That is bounded by reserving the claim before any chain
// work, refunding on failure, and the amount being small.

/** A confirmed transfer, as read from the chain by the caller. */
export interface OnChainTransfer {
  /** Who signed it. */
  from: string;
  /** Where it went. Native transfers have a `to`; contract creations do not. */
  to: string | null;
  /** Native MON moved, in wei. */
  valueWei: bigint;
  /** 1 for success. A reverted transfer moved nothing. */
  status: "success" | "reverted";
  /** How many blocks have built on it. */
  confirmations: number;
}

export interface PaymentExpectation {
  /** The wallet the signed-in player owns. */
  payer: string;
  /** The relayer wallet that will buy the licence. */
  relayer: string;
  /** The price quoted on the card, which is what they must have sent. */
  priceWei: bigint;
  /** Blocks required before the payment counts. */
  minConfirmations: number;
}

export const PAYMENT_REJECT_REASONS = [
  "payment_reverted",
  "payment_unconfirmed",
  "payment_wrong_recipient",
  "payment_wrong_payer",
  "payment_too_small",
] as const;
export type PaymentRejectReason = (typeof PAYMENT_REJECT_REASONS)[number];

export type PaymentCheck =
  | { ok: true; overpaidWei: bigint }
  | { ok: false; reason: PaymentRejectReason };

/**
 * Accept a payment only if every condition holds.
 *
 * Written as an explicit chain of rejections ending in a single accept, per
 * AGENTS.md rule 2 — reject by default, so an unanticipated shape falls out as
 * a refusal rather than slipping through a comparison.
 *
 * Address comparison is lowercased on both sides: the chain returns
 * checksummed addresses and `Player.walletAddress` is stored lowercased, so a
 * strict equality here would refuse every genuine payment.
 *
 * Note what this does NOT check: that the hash has not been used before. That
 * is not knowable from a transfer, only from the database, and it is enforced
 * by the unique index on EditionClaim.paymentTxHash. A verifier that tried to
 * answer it here would be guessing.
 */
export function checkPayment(
  transfer: OnChainTransfer,
  expect: PaymentExpectation,
): PaymentCheck {
  if (transfer.status !== "success") {
    return { ok: false, reason: "payment_reverted" };
  }
  if (!(transfer.confirmations >= expect.minConfirmations)) {
    return { ok: false, reason: "payment_unconfirmed" };
  }
  if (
    transfer.to === null ||
    transfer.to.toLowerCase() !== expect.relayer.toLowerCase()
  ) {
    return { ok: false, reason: "payment_wrong_recipient" };
  }
  // The payer must be the signed-in player. Without this, anyone could point
  // at somebody else's transfer to the relayer and claim a licence with it.
  if (transfer.from.toLowerCase() !== expect.payer.toLowerCase()) {
    return { ok: false, reason: "payment_wrong_payer" };
  }
  if (!(transfer.valueWei >= expect.priceWei)) {
    return { ok: false, reason: "payment_too_small" };
  }
  // Overpayment is accepted rather than refused: refusing would strand money
  // already spent, which is worse for the hunter than letting it through. The
  // surplus is reported so the caller can record it honestly.
  return { ok: true, overpaidWei: transfer.valueWei - expect.priceWei };
}

/**
 * What the card must require before enabling BUY.
 *
 * A hunter with exactly the price cannot pay it — the transfer itself costs
 * gas, and a wallet emptied to the last wei leaves them unable to collect the
 * next spawn either. So the button needs price PLUS a buffer, and the shortfall
 * shown has to include it or people tap BUY and watch it fail.
 */
export function affordableWithGas(
  balanceWei: bigint,
  priceWei: bigint,
  gasBufferWei: bigint,
): { ok: boolean; shortfallWei: bigint } {
  if (!(priceWei >= 0n && gasBufferWei >= 0n)) {
    throw new RangeError("affordableWithGas: negative price or buffer");
  }
  const needed = priceWei + gasBufferWei;
  const ok = balanceWei >= needed;
  return { ok, shortfallWei: ok ? 0n : needed - balanceWei };
}
