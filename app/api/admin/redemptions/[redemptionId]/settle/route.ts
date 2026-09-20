// Settle a PENDING redemption on chain. The irreversible step.
//
// Mirrors admin/payouts/[payoutId]/send: an audit row is written BEFORE the
// broadcast as well as after, so a process that dies mid-settle still leaves a
// record of who initiated it.
//
// The heavy lifting is in lib/hunt/settlement.ts, which serialises through the
// same treasury queue payouts use — the settler and the payout wallet are the
// same key, and two unserialised sends read the same pending nonce.

import { AdminRole } from "@prisma/client";
import { requestIp, requireAdminApi } from "@/lib/admin/auth";
import { logAdminAction } from "@/lib/admin/audit";
import { adminErrorResponse, jsonError, jsonOk } from "@/lib/admin/http";
import { settleRedemption } from "@/lib/hunt/settlement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Up to three broadcasts (wrap, approve, pay), each awaited to a receipt.
export const maxDuration = 120;

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ redemptionId: string }> },
) {
  try {
    const admin = await requireAdminApi(AdminRole.OPERATOR);
    const { redemptionId } = await ctx.params;
    const ip = await requestIp();

    await logAdminAction({
      adminId: admin.id,
      action: "redemption.settle",
      targetType: "Redemption",
      targetId: redemptionId,
      detail: "settlement initiated",
      ip,
    });

    const result = await settleRedemption(redemptionId, admin.id);

    await logAdminAction({
      adminId: admin.id,
      action: "redemption.settle",
      targetType: "Redemption",
      targetId: redemptionId,
      detail: result.ok
        ? `settled tx=${result.txHash ?? "unknown"}`
        : `failed: ${result.error ?? "unknown"}${result.needsReconciliation ? " (NEEDS RECONCILIATION)" : ""}`,
      ip,
    });

    if (!result.ok) {
      // 409 for a refusal the operator can act on; the reconciliation case is
      // called out explicitly so nobody retries a maybe-landed payment.
      return jsonError(
        result.error ?? "settle failed",
        409,
      );
    }
    return jsonOk({ ok: true, txHash: result.txHash ?? null });
  } catch (e) {
    return adminErrorResponse(e);
  }
}
