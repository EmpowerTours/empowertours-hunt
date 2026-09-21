// Create a cache. OPERATOR.
//
// This is one of the two endpoints in the system that handle cache
// coordinates. It only ever RECEIVES them; nothing here echoes a coordinate
// back in a response body or an error string, because an error message is a
// client-facing payload like any other.

import { AdminRole, Prisma } from "@prisma/client";
import { toWei } from "@/lib/wei";
import { explainPlantRefusal, mayPlantCache } from "@/lib/hunt/sembrador";
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
      select: {
        id: true,
        budgetCreditWei: true,
        spentCreditWei: true,
        caches: {
          where: { active: true },
          select: { lat: true, lng: true, rewardCreditWei: true },
        },
      },
    });
    if (!hunt) return jsonError("hunt not found", 404);

    const input = parseCacheInput(await readJson(req), "create");

    // THE ADMIN ROUTE ENFORCED NONE OF THE SEMBRADOR RULES.
    //
    // A Sembrador planting in their own city is held to 60m spacing, a radius
    // range and a 50-cache cap. The admin route — the one that can also attach
    // a credit reward — checked none of them, so the abuse those rules exist to
    // stop was available to exactly the caller who could make it pay: fifty
    // caches on one bench, each paying credit, collected by one standing
    // player. The rules are the same rules; only the caller differed.
    //
    // Plus the budget check, which is why `rewardCreditWei: 0` was hardcoded in
    // the public route. A cache promising credit the hunt cannot pay sends
    // somebody walking and fails at the claim. Now that hunts can be funded,
    // check it rather than forbid it.
    const rewardWei = toWei(input.rewardCreditWei ?? new Prisma.Decimal(0));
    const plantedWei = hunt.caches.reduce(
      (sum, c) => sum + toWei(c.rewardCreditWei),
      0n,
    );
    const plant = mayPlantCache({
      lat: input.lat!,
      lng: input.lng!,
      radiusMeters: input.radiusMeters ?? 25,
      existing: hunt.caches.map((c) => ({ lat: c.lat, lng: c.lng })),
      reward: {
        rewardCreditWei: rewardWei,
        plantedCreditWei: plantedWei,
        budgetCreditWei: toWei(hunt.budgetCreditWei),
        spentCreditWei: toWei(hunt.spentCreditWei),
      },
    });
    if (!plant.ok) {
      return jsonError(explainPlantRefusal(plant.reason, "en"), 400);
    }

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
