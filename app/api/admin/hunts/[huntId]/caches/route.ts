// Create a cache. OPERATOR.
//
// This is one of the two endpoints in the system that handle cache
// coordinates. It only ever RECEIVES them; nothing here echoes a coordinate
// back in a response body or an error string, because an error message is a
// client-facing payload like any other.

import { AdminRole, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { requestIp, requireAdminApi } from "@/lib/admin/auth";
import { logAdminAction } from "@/lib/admin/audit";
import { parseCacheInput } from "@/lib/admin/hunt-input";
import {
  adminErrorResponse,
  jsonError,
  jsonOk,
  readJson,
} from "@/lib/admin/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ huntId: string }> },
) {
  try {
    const admin = await requireAdminApi(AdminRole.OPERATOR);
    const { huntId } = await ctx.params;
    const ip = await requestIp();

    const hunt = await prisma.hunt.findUnique({
      where: { id: huntId },
      select: { id: true },
    });
    if (!hunt) return jsonError("hunt not found", 404);

    const input = parseCacheInput(await readJson(req), "create");

    const cache = await prisma.cache.create({
      data: {
        huntId,
        lat: input.lat!,
        lng: input.lng!,
        radiusMeters: input.radiusMeters ?? 25,
        rewardCreditWei: input.rewardCreditWei ?? new Prisma.Decimal(0),
        label: input.label ?? null,
        blurb: input.blurb ?? null,
        photoCid: input.photoCid ?? null,
        active: input.active ?? true,
      },
      select: { id: true },
    });

    // Coordinates ARE recorded in the audit detail. The trail is admin-only,
    // append-only, and "who moved a cache and where to" is precisely the
    // question it should answer.
    await logAdminAction({
      adminId: admin.id,
      action: "cache.create",
      targetType: "Cache",
      targetId: cache.id,
      detail: `hunt=${huntId} at ${input.lat},${input.lng} r=${input.radiusMeters ?? 25}m reward=${(input.rewardCreditWei ?? new Prisma.Decimal(0)).toFixed(0)} wei`,
      ip,
    });

    return jsonOk({ ok: true, cacheId: cache.id }, 201);
  } catch (e) {
    return adminErrorResponse(e);
  }
}
