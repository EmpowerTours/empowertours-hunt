// Edit a hunt. OPERATOR.
//
// Every field on this route loosens or tightens a control, so the diff is
// computed against the stored row and written into the audit trail field by
// field. "Someone raised maxSpeedKmh from 60 to 900 an hour before the payout
// spike" is the kind of thing the trail exists to make findable.

import { AdminRole, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { requestIp, requireAdminApi } from "@/lib/admin/auth";
import { logAdminAction } from "@/lib/admin/audit";
import {
  parseHuntInput,
  validateHuntConsistency,
} from "@/lib/admin/hunt-input";
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
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Prisma.Decimal) return `${value.toFixed(0)} wei`;
  return String(value);
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ huntId: string }> },
) {
  try {
    const admin = await requireAdminApi(AdminRole.OPERATOR);
    const { huntId } = await ctx.params;
    const ip = await requestIp();

    const existing = await prisma.hunt.findUnique({ where: { id: huntId } });
    if (!existing) return jsonError("hunt not found", 404);

    const patch = parseHuntInput(await readJson(req), "update");
    if (Object.keys(patch).length === 0) {
      throw new AdminInputError("nothing to update");
    }

    // Validate the MERGED row, not the patch. Raising spawnMaxMon alone is
    // fine; lowering it below an unchanged spawnMinMon is not, and only the
    // merge can tell the difference.
    validateHuntConsistency({
      spawnMinWei: patch.spawnMinWei ?? existing.spawnMinWei,
      spawnMaxWei: patch.spawnMaxWei ?? existing.spawnMaxWei,
      spawnMinRadiusM: patch.spawnMinRadiusM ?? existing.spawnMinRadiusM,
      spawnMaxRadiusM: patch.spawnMaxRadiusM ?? existing.spawnMaxRadiusM,
      startsAt:
        patch.startsAt !== undefined ? patch.startsAt : existing.startsAt,
      endsAt: patch.endsAt !== undefined ? patch.endsAt : existing.endsAt,
      spawnEnabled: patch.spawnEnabled ?? existing.spawnEnabled,
      budgetMonWei: patch.budgetMonWei ?? existing.budgetMonWei,
      autoApproveMaxWei: patch.autoApproveMaxWei ?? existing.autoApproveMaxWei,
    });

    const changes: string[] = [];
    for (const [key, next] of Object.entries(patch)) {
      const before = (existing as unknown as Record<string, unknown>)[key];
      const beforeStr = describe(before);
      const afterStr = describe(next);
      if (beforeStr !== afterStr)
        changes.push(`${key}: ${beforeStr} -> ${afterStr}`);
    }
    if (changes.length === 0) return jsonOk({ ok: true, changed: 0 });

    await prisma.hunt.update({
      where: { id: huntId },
      data: patch as Prisma.HuntUpdateInput,
    });

    await logAdminAction({
      adminId: admin.id,
      action: "hunt.update",
      targetType: "Hunt",
      targetId: huntId,
      detail: changes.join("; "),
      ip,
    });

    return jsonOk({ ok: true, changed: changes.length, changes });
  } catch (e) {
    return adminErrorResponse(e);
  }
}
