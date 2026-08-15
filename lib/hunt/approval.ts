// Auto-approval policy — the only place a payout is released without a person.
//
// The house rule is "human gate before anything irreversible". Auto-approval is
// a deliberate, bounded exception to it: a 0.001 MON spawn is not worth waking
// someone for, and a queue no one drains is a queue that gets rubber-stamped in
// bulk, which is worse than a small automatic bound.
//
// So the exception is written as a set of ceilings, and `Payout.autoApproved`
// records every use of it. That column is what lets the audit answer the only
// question that matters here: "how much has ever moved without a human looking
// at it?"
//
// Reject by default. `decideAutoApproval` returns HOLD unless every condition
// is explicitly satisfied, and every comparison is written as `!(good)` so a
// NaN, a null or a missing figure holds the payout rather than releasing it.

import { toWei } from "@/lib/wei";
import { prisma } from "@/lib/db/prisma";

export const APPROVAL_HOLD_REASONS = [
  "auto_approval_disabled",
  "non_positive_amount",
  "amount_above_per_payout_cap",
  "daily_auto_approve_cap",
  "attempt_flagged",
  "player_suspended",
  "player_not_active",
] as const;
export type ApprovalHoldReason = (typeof APPROVAL_HOLD_REASONS)[number];

export interface AutoApprovalContext {
  /** The payout being considered. */
  amountWei: bigint;
  /** Hunt.autoApproveMaxWei — 0 disables auto-approval entirely. */
  autoApproveMaxWei: bigint;
  /** Hunt.autoApproveDailyCapWei — 0 disables auto-approval entirely. */
  autoApproveDailyCapWei: bigint;
  /** Sum of auto-approved payouts across this hunt in the rolling 24h,
   *  EXCLUDING the one being decided. */
  autoApprovedLast24hWei: bigint;
  /** The ClaimAttempt that produced this payout was flagged by the verifier. */
  attemptFlagged: boolean;
  playerSuspended: boolean;
  playerActive: boolean;
}

export interface AutoApproved {
  autoApprove: true;
}
export interface HeldForHuman {
  autoApprove: false;
  reason: ApprovalHoldReason;
  detail: string;
}
export type ApprovalDecision = AutoApproved | HeldForHuman;

function hold(reason: ApprovalHoldReason, detail: string): HeldForHuman {
  return { autoApprove: false, reason, detail };
}

/**
 * May this payout skip the human gate?
 *
 * Pure. No DB, no clock — the caller supplies the rolling total so that the
 * decision is reproducible from stored rows during a dispute.
 */
export function decideAutoApproval(ctx: AutoApprovalContext): ApprovalDecision {
  // A flagged attempt is a suspected spoof. It never auto-approves, whatever
  // the amount — checked first so the reason recorded is the interesting one.
  if (ctx.attemptFlagged) {
    return hold("attempt_flagged", "originating claim attempt was flagged");
  }
  if (ctx.playerSuspended) {
    return hold("player_suspended", "player is suspended");
  }
  if (!ctx.playerActive) {
    return hold("player_not_active", "player is not active");
  }

  if (!(ctx.amountWei > 0n)) {
    return hold(
      "non_positive_amount",
      `amount ${ctx.amountWei} is not positive`,
    );
  }

  // 0 disables auto-approval entirely, restoring the strict human gate. This
  // is the schema default, so a hunt that nobody has configured pays nothing
  // automatically.
  if (!(ctx.autoApproveMaxWei > 0n)) {
    return hold("auto_approval_disabled", "hunt.autoApproveMaxWei is 0");
  }
  if (!(ctx.autoApproveDailyCapWei > 0n)) {
    return hold("auto_approval_disabled", "hunt.autoApproveDailyCapWei is 0");
  }

  if (!(ctx.amountWei <= ctx.autoApproveMaxWei)) {
    return hold(
      "amount_above_per_payout_cap",
      `${ctx.amountWei} exceeds per-payout cap ${ctx.autoApproveMaxWei}`,
    );
  }

  // The blast radius if the verifier is ever fooled at scale: past this line
  // every further payout in the window waits for a person.
  if (!(ctx.autoApprovedLast24hWei >= 0n)) {
    return hold(
      "daily_auto_approve_cap",
      `rolling 24h total ${ctx.autoApprovedLast24hWei} is not a valid figure`,
    );
  }
  if (
    !(ctx.autoApprovedLast24hWei + ctx.amountWei <= ctx.autoApproveDailyCapWei)
  ) {
    return hold(
      "daily_auto_approve_cap",
      `${ctx.autoApprovedLast24hWei} + ${ctx.amountWei} exceeds the rolling 24h auto-approval cap ${ctx.autoApproveDailyCapWei}`,
    );
  }

  return { autoApprove: true };
}

/**
 * Rolling-24h total of auto-approved payouts across one hunt, in wei.
 *
 * Counts every payout that auto-approval ever released — including SENT ones —
 * because the cap bounds what policy has RELEASED, not what is still moving.
 * Voided rows are excluded: they were released and then taken back by a human,
 * so holding their value against the window would punish the correction.
 *
 * Payout has no huntId of its own; it hangs off the spawn that earned it.
 *
 * Accepts a transaction client so the caller can read this inside the same
 * transaction that writes the payout.
 */
export async function sumAutoApprovedLast24hWei(
  huntId: string,
  now: Date,
  client: Pick<typeof prisma, "payout"> = prisma,
): Promise<bigint> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const agg = await client.payout.aggregate({
    where: {
      autoApproved: true,
      createdAt: { gte: since },
      status: { not: "VOIDED" },
      spawn: { huntId },
    },
    _sum: { amountMonWei: true },
  });
  const sum = agg._sum.amountMonWei;
  return sum === null || sum === undefined ? 0n : toWei(sum);
}
