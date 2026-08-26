// Retire or delete a walkable zone. OPERATOR.
//
// PATCH toggles `active`, which is the normal way to take a zone out of play:
// the row and its audit history survive, and turning it back on is one click.
// DELETE is for a zone that should never have existed — a mis-traced outline —
// and is separate precisely so "stop using this" is not spelled the same way as
// "erase the evidence".
//
// Note what deactivating an INCLUDE zone does: if it was the only one, the hunt
// has no walkable ground left and stops placing spawns entirely. That is the
// intended failure direction, but it is abrupt, so the response says so.

import { AdminRole } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { requestIp, requireAdminApi } from "@/lib/admin/auth";
import { logAdminAction } from "@/lib/admin/audit";
import {
  adminErrorResponse,
  jsonError,
  jsonOk,
  readJson,
} from "@/lib/admin/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How many INCLUDE zones would still be live for this hunt afterwards. */
async function remainingIncludeCount(huntId: string, excludingZoneId: string) {
  return prisma.zone.count({
    where: {
      huntId,
      kind: "INCLUDE",
      active: true,
      NOT: { id: excludingZoneId },
    },
  });
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ zoneId: string }> },
) {
  try {
    const admin = await requireAdminApi(AdminRole.OPERATOR);
    const { zoneId } = await ctx.params;
    const ip = await requestIp();

    const body = (await readJson(req)) as { active?: unknown };
    if (typeof body.active !== "boolean") {
      return jsonError("active must be true or false", 400);
    }

    const zone = await prisma.zone.findUnique({
      where: { id: zoneId },
      select: { id: true, huntId: true, kind: true, name: true, active: true },
    });
    if (!zone) return jsonError("zone not found", 404);

    // Conditional on the value we read, so two operators toggling at once
    // cannot both believe they made the change.
    const updated = await prisma.zone.updateMany({
      where: { id: zoneId, active: zone.active },
      data: { active: body.active },
    });
    if (updated.count === 0) {
      return jsonError("zone was changed by someone else, reload", 409);
    }

    await logAdminAction({
      adminId: admin.id,
      action: body.active ? "zone.activate" : "zone.deactivate",
      targetType: "Zone",
      targetId: zoneId,
      detail: `hunt=${zone.huntId} ${zone.kind} "${zone.name ?? "unnamed"}"`,
      ip,
    });

    const includesLeft =
      zone.kind === "INCLUDE" && !body.active
        ? await remainingIncludeCount(zone.huntId, zoneId)
        : null;

    return jsonOk({
      ok: true,
      active: body.active,
      spawnsHalted: includesLeft === 0,
    });
  } catch (e) {
    return adminErrorResponse(e);
  }
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ zoneId: string }> },
) {
  try {
    const admin = await requireAdminApi(AdminRole.OPERATOR);
    const { zoneId } = await ctx.params;
    const ip = await requestIp();

    const zone = await prisma.zone.findUnique({
      where: { id: zoneId },
      select: { id: true, huntId: true, kind: true, name: true },
    });
    if (!zone) return jsonError("zone not found", 404);

    const includesLeft =
      zone.kind === "INCLUDE"
        ? await remainingIncludeCount(zone.huntId, zoneId)
        : null;

    await prisma.zone.delete({ where: { id: zoneId } });

    await logAdminAction({
      adminId: admin.id,
      action: "zone.delete",
      targetType: "Zone",
      targetId: zoneId,
      detail: `hunt=${zone.huntId} ${zone.kind} "${zone.name ?? "unnamed"}"`,
      ip,
    });

    return jsonOk({ ok: true, spawnsHalted: includesLeft === 0 });
  } catch (e) {
    return adminErrorResponse(e);
  }
}
