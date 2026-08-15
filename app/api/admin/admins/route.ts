// Admin roster. OWNER only.
//
// Addresses are stored lowercased, always — a checksummed row would never match
// the lowercased lookup in `resolveAdmin` and the account would silently never
// work, or worse, two rows would exist for one wallet.

import { AdminRole } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { requestIp, requireAdminApi } from "@/lib/admin/auth";
import { logAdminAction } from "@/lib/admin/audit";
import {
  AdminInputError,
  adminErrorResponse,
  jsonError,
  jsonOk,
  optionalString,
  readJson,
  requireString,
} from "@/lib/admin/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseRole(raw: string): AdminRole {
  if (
    raw === AdminRole.VIEWER ||
    raw === AdminRole.OPERATOR ||
    raw === AdminRole.OWNER
  ) {
    return raw;
  }
  throw new AdminInputError("role must be VIEWER, OPERATOR or OWNER");
}

export async function POST(req: Request) {
  try {
    const admin = await requireAdminApi(AdminRole.OWNER);
    const ip = await requestIp();
    const body = await readJson(req);

    const walletAddress = requireString(body, "walletAddress", {
      min: 42,
      max: 42,
    }).toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(walletAddress)) {
      throw new AdminInputError(
        "walletAddress must be a 0x-prefixed 20-byte address",
      );
    }
    const role = parseRole(requireString(body, "role", { min: 4, max: 8 }));
    const label = optionalString(body, "label", 120);

    const existing = await prisma.adminUser.findUnique({
      where: { walletAddress },
      select: { id: true },
    });
    if (existing) return jsonError("that wallet is already an admin", 409);

    const created = await prisma.adminUser.create({
      data: { walletAddress, role, label: label ?? null },
      select: { id: true },
    });

    await logAdminAction({
      adminId: admin.id,
      action: "admin.create",
      targetType: "AdminUser",
      targetId: created.id,
      detail: `granted ${role} to ${walletAddress}${label ? ` (${label})` : ""}`,
      ip,
    });

    return jsonOk({ ok: true, adminId: created.id }, 201);
  } catch (e) {
    return adminErrorResponse(e);
  }
}
