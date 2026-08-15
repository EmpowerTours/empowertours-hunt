// Suspend a player. OPERATOR. Reason mandatory.
//
// `active` and `suspendedAt` are both set. The schema keeps them distinct on
// purpose — `active` is what the claim path checks before any positional work
// happens, `suspendedAt` is what makes the suspension legible in the audit
// trail — so a suspension writes both and an unsuspension clears both.

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

    // Conditional on not already being suspended, so a double click does not
    // overwrite the original suspension timestamp and reason.
    const updated = await prisma.player.updateMany({
      where: { id: playerId, suspendedAt: null },
      data: {
        active: false,
        suspendedAt: new Date(),
        suspendReason: reason,
      },
    });

    if (updated.count === 0) {
      const exists = await prisma.player.findUnique({
        where: { id: playerId },
        select: { suspendedAt: true },
      });
      return jsonError(
        exists ? "player is already suspended" : "player not found",
        exists ? 409 : 404,
      );
    }

    await logAdminAction({
      adminId: admin.id,
      action: "player.suspend",
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
