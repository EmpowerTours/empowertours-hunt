// Broadcast an APPROVED payout. The irreversible step.
//
// Two guards, both server-side:
//   1. `assertSendable` refuses anything that is not APPROVED, and refuses
//      SENDING and NEEDS_RECONCILIATION with an explicit explanation — those
//      two mean a transaction is or may already be on the wire, and re-sending
//      is how you pay twice.
//   2. `sendApprovedPayout` (payout lane) claims the row with its own
//      conditional update before it broadcasts, so the race between two
//      operators clicking at once is resolved in the database, not here.
//
// The audit row is written BEFORE the broadcast as well as after. If the
// process dies mid-send there is still a record of who initiated it.

import { AdminRole } from "@prisma/client";
import { requestIp, requireAdminApi } from "@/lib/admin/auth";
import { logAdminAction } from "@/lib/admin/audit";
import { assertSendable } from "@/lib/admin/payouts";
import { adminErrorResponse, jsonError, jsonOk } from "@/lib/admin/http";
import { sendApprovedPayout } from "@/lib/hunt/payout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Broadcasting and waiting for a receipt is not a sub-second operation.
export const maxDuration = 60;

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ payoutId: string }> },
) {
  try {
    const admin = await requireAdminApi(AdminRole.OPERATOR);
    const { payoutId } = await ctx.params;
    const ip = await requestIp();

    await assertSendable(payoutId);

    await logAdminAction({
      adminId: admin.id,
      action: "payout.send",
      targetType: "Payout",
      targetId: payoutId,
      detail: "broadcast initiated",
      ip,
    });

    const result = await sendApprovedPayout(payoutId);

    await logAdminAction({
      adminId: admin.id,
      action: "payout.send",
      targetType: "Payout",
      targetId: payoutId,
      detail: result.ok
        ? `broadcast ok tx=${result.txHash ?? "unknown"}`
        : `broadcast failed: ${result.error ?? "unknown"}`,
      ip,
    });

    if (!result.ok) {
      return jsonError(result.error ?? "send failed", 409);
    }
    return jsonOk({ ok: true, txHash: result.txHash ?? null });
  } catch (e) {
    return adminErrorResponse(e);
  }
}
