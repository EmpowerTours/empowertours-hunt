// The payout state machine, enforced.
//
// Transitions, copied from prisma/schema.prisma — this file is the enforcement
// of that comment, not a second opinion on it:
//
//   PENDING              -> APPROVED | VOIDED
//   APPROVED             -> SENDING  | VOIDED
//   SENDING              -> SENT | FAILED | NEEDS_RECONCILIATION
//   SENT                 terminal
//   FAILED               -> APPROVED, and ONLY while txHash IS NULL
//   NEEDS_RECONCILIATION -> SENT | FAILED       (resolved against the chain)
//   VOIDED               terminal
//
// Two properties are load-bearing:
//
// 1. EVERY transition here is one conditional UPDATE whose affected-row count
//    is checked. Never read-then-write. Two operators clicking Approve on the
//    same row a millisecond apart must produce one approval and one 409, and a
//    read-then-write produces two approvals — which, one step later, is two
//    broadcasts of the same real MON.
//
// 2. NEEDS_RECONCILIATION is NOT re-sendable. That status means the
//    transaction was broadcast and the outcome is unknown. Offering a "retry"
//    for it would send the money a second time. It is resolved by looking the
//    transaction up on Monad and recording what was found — which is why
//    `reconcilePayout` demands evidence and never touches the send path.

import { PayoutStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AdminConflictError, AdminInputError } from "@/lib/admin/http";

export const LEGAL_TRANSITIONS: Record<PayoutStatus, readonly PayoutStatus[]> =
  {
    [PayoutStatus.PENDING]: [PayoutStatus.APPROVED, PayoutStatus.VOIDED],
    [PayoutStatus.APPROVED]: [PayoutStatus.SENDING, PayoutStatus.VOIDED],
    [PayoutStatus.SENDING]: [
      PayoutStatus.SENT,
      PayoutStatus.FAILED,
      PayoutStatus.NEEDS_RECONCILIATION,
    ],
    [PayoutStatus.SENT]: [],
    // Conditional on txHash IS NULL. The type cannot express that, so every
    // caller goes through `approvePayout`, which puts the condition in the WHERE.
    [PayoutStatus.FAILED]: [PayoutStatus.APPROVED],
    [PayoutStatus.NEEDS_RECONCILIATION]: [
      PayoutStatus.SENT,
      PayoutStatus.FAILED,
    ],
    [PayoutStatus.VOIDED]: [],
  };

export function isLegalTransition(
  from: PayoutStatus,
  to: PayoutStatus,
): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/** Statuses an operator may act on at all, used to gate the UI's affordances. */
export const ACTIONABLE_STATUSES: readonly PayoutStatus[] = [
  PayoutStatus.PENDING,
  PayoutStatus.APPROVED,
  PayoutStatus.FAILED,
  PayoutStatus.NEEDS_RECONCILIATION,
];

export interface TransitionResult {
  ok: boolean;
  from?: PayoutStatus;
  to?: PayoutStatus;
  reason?: string;
}

/** Current status, read only to explain a refusal that already happened. */
async function currentStatus(
  payoutId: string,
): Promise<{ status: PayoutStatus; txHash: string | null } | null> {
  return prisma.payout.findUnique({
    where: { id: payoutId },
    select: { status: true, txHash: true },
  });
}

function explainRefusal(
  row: { status: PayoutStatus; txHash: string | null } | null,
  intent: PayoutStatus,
): string {
  if (!row) return "payout not found";
  if (row.status === PayoutStatus.FAILED && row.txHash) {
    return "this payout failed AFTER a transaction was broadcast — it carries a txHash and must be reconciled against the chain, never re-approved";
  }
  if (row.status === PayoutStatus.NEEDS_RECONCILIATION) {
    return "this payout is NEEDS_RECONCILIATION: it was broadcast and its outcome is unknown. Resolve it against Monad — re-sending would pay twice";
  }
  return `payout is ${row.status}; ${intent} is not a legal transition from there`;
}

/**
 * PENDING -> APPROVED, or FAILED -> APPROVED while txHash IS NULL.
 *
 * The `txHash: null` clause is the guard that stops a payout that already put a
 * transaction on the wire from being queued for a second one.
 */
export async function approvePayout(params: {
  payoutId: string;
  adminId: string;
}): Promise<TransitionResult> {
  const updated = await prisma.payout.updateMany({
    where: {
      id: params.payoutId,
      OR: [
        { status: PayoutStatus.PENDING },
        { status: PayoutStatus.FAILED, txHash: null },
      ],
    },
    data: {
      status: PayoutStatus.APPROVED,
      approvedBy: params.adminId,
      approvedAt: new Date(),
      // Explicitly false: a human is looking at it right now, so this row is no
      // longer part of the "moved without a human" total.
      autoApproved: false,
      failReason: null,
    },
  });

  if (updated.count === 0) {
    const row = await currentStatus(params.payoutId);
    return {
      ok: false,
      from: row?.status,
      reason: explainRefusal(row, PayoutStatus.APPROVED),
    };
  }
  return { ok: true, to: PayoutStatus.APPROVED };
}

/** PENDING -> VOIDED or APPROVED -> VOIDED. Terminal, and requires a reason. */
export async function voidPayout(params: {
  payoutId: string;
  adminId: string;
  reason: string;
}): Promise<TransitionResult> {
  if (params.reason.trim().length < 4) {
    throw new AdminInputError("a void reason is required");
  }
  const updated = await prisma.payout.updateMany({
    where: {
      id: params.payoutId,
      status: { in: [PayoutStatus.PENDING, PayoutStatus.APPROVED] },
    },
    data: {
      status: PayoutStatus.VOIDED,
      voidReason: `${params.reason.trim()} (by ${params.adminId})`,
      approvedBy: params.adminId,
      approvedAt: new Date(),
    },
  });

  if (updated.count === 0) {
    const row = await currentStatus(params.payoutId);
    return {
      ok: false,
      from: row?.status,
      reason: explainRefusal(row, PayoutStatus.VOIDED),
    };
  }
  return { ok: true, to: PayoutStatus.VOIDED };
}

export type ReconcileOutcome = "SENT" | "FAILED";

/**
 * Resolve a NEEDS_RECONCILIATION row against what the chain actually says.
 *
 * This is the only exit from that status and it is NOT a retry:
 *
 *   SENT   the operator found the transaction confirmed. They supply its hash,
 *          which is written to a UNIQUE column — so the same hash cannot be
 *          used to close out two different payouts.
 *   FAILED the operator confirmed no transfer landed. txHash is cleared,
 *          because the schema only permits FAILED while txHash IS NULL, and
 *          that null is exactly what re-opens the FAILED -> APPROVED path. The
 *          evidence they checked is recorded so this assertion is attributable.
 */
export async function reconcilePayout(params: {
  payoutId: string;
  adminId: string;
  outcome: ReconcileOutcome;
  txHash?: string;
  evidence: string;
}): Promise<TransitionResult> {
  const evidence = params.evidence.trim();
  if (evidence.length < 10) {
    throw new AdminInputError(
      "reconciliation requires written evidence (what you checked on Monad, and what you found)",
    );
  }

  let data: Prisma.PayoutUpdateManyMutationInput;

  if (params.outcome === "SENT") {
    const txHash = params.txHash?.trim().toLowerCase() ?? "";
    if (!/^0x[0-9a-f]{64}$/.test(txHash)) {
      throw new AdminInputError(
        "resolving to SENT requires the confirmed transaction hash (0x + 64 hex characters)",
      );
    }
    data = {
      status: PayoutStatus.SENT,
      txHash,
      sentAt: new Date(),
      failReason: null,
      reconciledBy: params.adminId,
      reconciledAt: new Date(),
    };
  } else {
    data = {
      status: PayoutStatus.FAILED,
      // Must be null for FAILED to be a valid state per the schema.
      txHash: null,
      failReason: `reconciled as never-broadcast: ${evidence}`,
      reconciledBy: params.adminId,
      reconciledAt: new Date(),
    };
  }

  try {
    const updated = await prisma.payout.updateMany({
      where: { id: params.payoutId, status: PayoutStatus.NEEDS_RECONCILIATION },
      data,
    });
    if (updated.count === 0) {
      const row = await currentStatus(params.payoutId);
      return {
        ok: false,
        from: row?.status,
        reason: row
          ? `only a NEEDS_RECONCILIATION payout can be reconciled; this one is ${row.status}`
          : "payout not found",
      };
    }
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    ) {
      throw new AdminConflictError(
        "that transaction hash is already recorded against another payout — check you have the right hash before closing this one out",
      );
    }
    throw e;
  }

  return {
    ok: true,
    to: params.outcome === "SENT" ? PayoutStatus.SENT : PayoutStatus.FAILED,
  };
}

/**
 * Guard in front of the broadcast path.
 *
 * `sendApprovedPayout` does its own claim-the-row CAS, so this is belt and
 * braces — but it is the layer that produces a legible refusal for the two
 * statuses an operator might be tempted to force: SENDING (in flight) and
 * NEEDS_RECONCILIATION (already on the wire).
 */
export async function assertSendable(payoutId: string): Promise<void> {
  const row = await currentStatus(payoutId);
  if (!row) throw new AdminConflictError("payout not found");
  if (row.status === PayoutStatus.NEEDS_RECONCILIATION) {
    throw new AdminConflictError(
      "refusing to send: this payout was already broadcast and is awaiting reconciliation. Sending it again would pay twice",
    );
  }
  if (row.status === PayoutStatus.SENDING) {
    throw new AdminConflictError(
      "refusing to send: a broadcast is already in flight for this payout",
    );
  }
  if (row.status !== PayoutStatus.APPROVED) {
    throw new AdminConflictError(
      `only an APPROVED payout may be sent; this one is ${row.status}`,
    );
  }
}
