// Create a hunt. OPERATOR.
//
// A new hunt starts inactive, with spawns disabled and auto-approval off, no
// matter what the caller sends: an operator has to make three separate,
// audited decisions before real MON can leave the treasury for it.

import { AdminRole, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { requestIp, requireAdminApi } from "@/lib/admin/auth";
import { logAdminAction } from "@/lib/admin/audit";
import {
  HUNT_DEFAULTS,
  parseHuntInput,
  validateHuntConsistency,
} from "@/lib/admin/hunt-input";
import { fromWei, parseMonInput } from "@/lib/wei";
import { adminErrorResponse, jsonOk, readJson } from "@/lib/admin/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function decimalMon(input: string): Prisma.Decimal {
  return new Prisma.Decimal(fromWei(parseMonInput(input)));
}

export async function POST(req: Request) {
  try {
    const admin = await requireAdminApi(AdminRole.OPERATOR);
    const ip = await requestIp();
    const body = await readJson(req);
    const input = parseHuntInput(body, "create");

    const data: Prisma.HuntCreateInput = {
      name: input.name!,
      description: input.description ?? null,
      // Forced. Activation is its own audited edit.
      active: false,
      spawnEnabled: false,
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
      maxAccuracyM: input.maxAccuracyM ?? HUNT_DEFAULTS.maxAccuracyM,
      maxSpeedKmh: input.maxSpeedKmh ?? HUNT_DEFAULTS.maxSpeedKmh,
      cooldownSeconds: input.cooldownSeconds ?? HUNT_DEFAULTS.cooldownSeconds,
      maxClockSkewSeconds:
        input.maxClockSkewSeconds ?? HUNT_DEFAULTS.maxClockSkewSeconds,
      budgetCreditWei: input.budgetCreditWei ?? new Prisma.Decimal(0),
      maxFindsPerPlayer:
        input.maxFindsPerPlayer ?? HUNT_DEFAULTS.maxFindsPerPlayer,
      budgetMonWei: input.budgetMonWei ?? new Prisma.Decimal(0),
      spawnMinWei: input.spawnMinWei ?? decimalMon(HUNT_DEFAULTS.spawnMinMon),
      spawnMaxWei: input.spawnMaxWei ?? decimalMon(HUNT_DEFAULTS.spawnMaxMon),
      spawnMinRadiusM: input.spawnMinRadiusM ?? HUNT_DEFAULTS.spawnMinRadiusM,
      spawnMaxRadiusM: input.spawnMaxRadiusM ?? HUNT_DEFAULTS.spawnMaxRadiusM,
      spawnTtlSeconds: input.spawnTtlSeconds ?? HUNT_DEFAULTS.spawnTtlSeconds,
      spawnCooldownSeconds:
        input.spawnCooldownSeconds ?? HUNT_DEFAULTS.spawnCooldownSeconds,
      spawnDailyCapWeiPerPlayer:
        input.spawnDailyCapWeiPerPlayer ?? new Prisma.Decimal(0),
      // Auto-approval starts fully off — the strict human gate.
      autoApproveMaxWei: new Prisma.Decimal(0),
      autoApproveDailyCapWei: new Prisma.Decimal(0),
    };

    validateHuntConsistency({
      spawnMinWei: data.spawnMinWei as Prisma.Decimal,
      spawnMaxWei: data.spawnMaxWei as Prisma.Decimal,
      spawnMinRadiusM: data.spawnMinRadiusM as number,
      spawnMaxRadiusM: data.spawnMaxRadiusM as number,
      startsAt: (data.startsAt as Date | null) ?? null,
      endsAt: (data.endsAt as Date | null) ?? null,
      spawnEnabled: false,
      budgetMonWei: data.budgetMonWei as Prisma.Decimal,
      autoApproveMaxWei: data.autoApproveMaxWei as Prisma.Decimal,
    });

    const hunt = await prisma.hunt.create({
      data,
      select: { id: true, name: true },
    });

    await logAdminAction({
      adminId: admin.id,
      action: "hunt.create",
      targetType: "Hunt",
      targetId: hunt.id,
      detail: `created "${hunt.name}" (inactive, spawns off, auto-approval off)`,
      ip,
    });

    return jsonOk({ ok: true, huntId: hunt.id }, 201);
  } catch (e) {
    return adminErrorResponse(e);
  }
}
