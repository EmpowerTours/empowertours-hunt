// PENDING -> APPROVED, or FAILED -> APPROVED while txHash IS NULL.
//
// OPERATOR. A VIEWER hitting this by hand gets a 403 from the server; the fact
// that the UI does not render the button for them is not the control.

import { AdminRole } from "@prisma/client";
import { requestIp, requireAdminApi } from "@/lib/admin/auth";
import { logAdminAction } from "@/lib/admin/audit";
import { approvePayout } from "@/lib/admin/payouts";
import { adminErrorResponse, jsonError, jsonOk } from "@/lib/admin/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ payoutId: string }> },
) {
  try {
    const admin = await requireAdminApi(AdminRole.OPERATOR);
    const { payoutId } = await ctx.params;
    const ip = await requestIp();

    const result = await approvePayout({ payoutId, adminId: admin.id });

    if (!result.ok) {
      // A refused transition is itself worth recording: "who tried to approve
      // a payout that had already been broadcast" is an audit question.
      await logAdminAction({
        adminId: admin.id,
        action: "payout.transition.denied",
        targetType: "Payout",
        targetId: payoutId,
        detail: `approve refused: ${result.reason ?? "unknown"}`,
        ip,
      });
      return jsonError(result.reason ?? "approval refused", 409);
    }

    await logAdminAction({
      adminId: admin.id,
      action: "payout.approve",
      targetType: "Payout",
      targetId: payoutId,
      detail: "released for sending",
      ip,
    });

    return jsonOk({ ok: true, status: result.to });
  } catch (e) {
    return adminErrorResponse(e);
  }
}
