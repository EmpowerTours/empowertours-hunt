// Lift a suspension. OPERATOR. Reason mandatory — reinstating a wallet that
// was flagged for spoofing is exactly as much of a decision as suspending it,
// and the trail should say why.

import { AdminRole } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { requestIp, requireAdminApi } from "@/lib/admin/auth";
import { logAdminAction } from "@/lib/admin/audit";
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
  ctx: { params: Promise<{ playerId: string }> },
) {
  try {
    const admin = await requireAdminApi(AdminRole.OPERATOR);
    const { playerId } = await ctx.params;
    const ip = await requestIp();

    const body = await readJson(req);
    const reason = requireString(body, "reason", { min: 6, max: 500 });

    const updated = await prisma.player.updateMany({
      where: { id: playerId, suspendedAt: { not: null } },
      data: { active: true, suspendedAt: null, suspendReason: null },
    });

    if (updated.count === 0) {
      const exists = await prisma.player.findUnique({
        where: { id: playerId },
        select: { id: true },
      });
      return jsonError(
        exists ? "player is not suspended" : "player not found",
        exists ? 409 : 404,
      );
    }

    // The reason the suspension existed is cleared from the Player row; this
    // append-only entry is where the history survives.
    await logAdminAction({
      adminId: admin.id,
      action: "player.unsuspend",
      targetType: "Player",
      targetId: playerId,
      detail: reason,
      ip,
    });

    return jsonOk({ ok: true });
  } catch (e) {
    return adminErrorResponse(e);
  }
}
