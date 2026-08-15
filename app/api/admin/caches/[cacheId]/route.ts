// Edit or retire a cache. OPERATOR.
//
// DELETE deactivates rather than deleting. A Cache row is referenced by every
// Find made against it and by the credit those finds issued; removing it would
// orphan the ledger entries that justify a player's balance. Retiring it stops
// new finds and leaves the history intact.

import { AdminRole, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { requestIp, requireAdminApi } from "@/lib/admin/auth";
import { logAdminAction } from "@/lib/admin/audit";
import { parseCacheInput } from "@/lib/admin/hunt-input";
import {
  AdminInputError,
  adminErrorResponse,
  jsonError,
  jsonOk,
  readJson,
} from "@/lib/admin/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function describe(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (value instanceof Prisma.Decimal) return `${value.toFixed(0)} wei`;
  return String(value);
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ cacheId: string }> },
) {
  try {
    const admin = await requireAdminApi(AdminRole.OPERATOR);
    const { cacheId } = await ctx.params;
    const ip = await requestIp();

    const existing = await prisma.cache.findUnique({ where: { id: cacheId } });
    if (!existing) return jsonError("cache not found", 404);

    const patch = parseCacheInput(await readJson(req), "update");
    if (Object.keys(patch).length === 0) {
      throw new AdminInputError("nothing to update");
    }

    const changes: string[] = [];
    for (const [key, next] of Object.entries(patch)) {
      const before = (existing as unknown as Record<string, unknown>)[key];
      if (describe(before) !== describe(next)) {
        changes.push(`${key}: ${describe(before)} -> ${describe(next)}`);
      }
    }
    if (changes.length === 0) return jsonOk({ ok: true, changed: 0 });

    await prisma.cache.update({
      where: { id: cacheId },
      data: patch as Prisma.CacheUpdateInput,
    });

    // Editing rewardCreditWei does NOT change what past finds were worth —
    // Find.rewardCreditSnapshot froze that at find time — so this only affects
    // finds from here on.
    await logAdminAction({
      adminId: admin.id,
      action: "cache.update",
      targetType: "Cache",
      targetId: cacheId,
      detail: changes.join("; "),
      ip,
    });

    return jsonOk({ ok: true, changed: changes.length, changes });
  } catch (e) {
    return adminErrorResponse(e);
  }
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ cacheId: string }> },
) {
  try {
    const admin = await requireAdminApi(AdminRole.OPERATOR);
    const { cacheId } = await ctx.params;
    const ip = await requestIp();

    const updated = await prisma.cache.updateMany({
      where: { id: cacheId, active: true },
      data: { active: false },
    });
    if (updated.count === 0) {
      return jsonError("cache not found, or already retired", 409);
    }

    await logAdminAction({
      adminId: admin.id,
      action: "cache.deactivate",
      targetType: "Cache",
      targetId: cacheId,
      detail: "retired (rows preserved; existing finds and credit unaffected)",
      ip,
    });

    return jsonOk({ ok: true });
  } catch (e) {
    return adminErrorResponse(e);
  }
}
