// The admin audit trail.
//
// `AdminAction` is append-only. There is no update helper and no delete helper
// in this file, and there must never be one: the value of the trail is that a
// row written at the moment money moved cannot later be tidied up. If a record
// is wrong, write a correcting row.
//
// Every privileged mutation writes one row — approvals, voids, reconciliations,
// suspensions, reward edits, admin role changes — with the acting admin, the
// target, a human-readable detail and the caller IP.
//
// Denied attempts are logged too. "Who tried to approve a payout they were not
// allowed to approve" is exactly the question an audit trail should answer, and
// it is invisible if only successes are recorded.

import { prisma } from "@/lib/db/prisma";

export type AuditAction =
  | "payout.approve"
  | "payout.approve.batch"
  | "payout.void"
  | "payout.send"
  | "payout.reconcile"
  | "payout.transition.denied"
  | "player.suspend"
  | "player.unsuspend"
  | "player.credit.adjust"
  | "hunt.create"
  | "hunt.update"
  | "cache.create"
  | "cache.update"
  | "cache.deactivate"
  | "admin.create"
  | "admin.update"
  | "admin.login"
  | "admin.bootstrap";

export interface AuditEntry {
  adminId: string;
  action: AuditAction;
  targetType: "Payout" | "Player" | "Hunt" | "Cache" | "AdminUser" | "Session";
  targetId: string;
  detail?: string;
  ip?: string;
}

/**
 * Write one audit row.
 *
 * Never throws into the caller's path: an audit failure must not roll back a
 * mutation that already happened, or an operator would retry an approval that
 * in fact succeeded. It is logged loudly instead.
 */
export async function logAdminAction(entry: AuditEntry): Promise<void> {
  try {
    await prisma.adminAction.create({
      data: {
        adminId: entry.adminId,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        detail: entry.detail?.slice(0, 2000) ?? null,
        ip: entry.ip ?? null,
      },
    });
  } catch (e) {
    console.error("[admin-audit] FAILED to record action", {
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      error: e instanceof Error ? e.message : "unknown",
    });
  }
}

/**
 * Same row, written inside a caller-supplied transaction so the trail and the
 * mutation commit together. Used where the mutation is itself transactional
 * (credit adjustments), so the ledger and its justification cannot diverge.
 */
export async function logAdminActionTx(
  tx: Pick<typeof prisma, "adminAction">,
  entry: AuditEntry,
): Promise<void> {
  await tx.adminAction.create({
    data: {
      adminId: entry.adminId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      detail: entry.detail?.slice(0, 2000) ?? null,
      ip: entry.ip ?? null,
    },
  });
}
