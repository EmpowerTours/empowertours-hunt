// PENDING|APPROVED -> VOIDED. Terminal, OPERATOR, reason required.

import { AdminRole } from "@prisma/client";
import { requestIp, requireAdminApi } from "@/lib/admin/auth";
import { logAdminAction } from "@/lib/admin/audit";
import { voidPayout } from "@/lib/admin/payouts";
import {
  adminErrorResponse,
  jsonError,
  jsonOk,
  readJson,
  requireString,
} from "@/lib/admin/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ payoutId: string }> },
) {
  try {
    const admin = await requireAdminApi(AdminRole.OPERATOR);
    const { payoutId } = await ctx.params;
    const ip = await requestIp();

    const body = await readJson(req);
    const reason = requireString(body, "reason", { min: 4, max: 500 });

    const result = await voidPayout({ payoutId, adminId: admin.id, reason });

    if (!result.ok) {
      await logAdminAction({
        adminId: admin.id,
        action: "payout.transition.denied",
        targetType: "Payout",
        targetId: payoutId,
        detail: `void refused: ${result.reason ?? "unknown"}`,
        ip,
      });
      return jsonError(result.reason ?? "void refused", 409);
    }

    await logAdminAction({
      adminId: admin.id,
      action: "payout.void",
      targetType: "Payout",
      targetId: payoutId,
      detail: reason,
      ip,
    });

    return jsonOk({ ok: true, status: result.to });
  } catch (e) {
    return adminErrorResponse(e);
  }
}
