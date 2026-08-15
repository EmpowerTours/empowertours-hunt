// Change an admin's role, or deactivate them. OWNER only.
//
// Two lockout guards:
//
//   1. An OWNER cannot change their own role or deactivate themselves. This is
//      the primary guard and it has no race: the actor is, by definition, an
//      active OWNER at the moment of the request, and they are not the target,
//      so at least one active OWNER always survives the write.
//   2. Belt and braces, the transaction re-counts active OWNERs afterwards and
//      rolls back if it hit zero. That covers two owners demoting each other
//      at the same instant, which guard 1 alone does not.
//
// Losing the last OWNER is not a small inconvenience: the bootstrap path only
// fires on an EMPTY AdminUser table, so there would be no way back in.

import { AdminRole } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { requestIp, requireAdminApi } from "@/lib/admin/auth";
import { logAdminActionTx } from "@/lib/admin/audit";
import {
  AdminInputError,
  adminErrorResponse,
  jsonError,
  jsonOk,
  optionalBool,
  optionalString,
  readJson,
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

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ adminId: string }> },
) {
  try {
    const actor = await requireAdminApi(AdminRole.OWNER);
    const { adminId } = await ctx.params;
    const ip = await requestIp();
    const body = await readJson(req);

    if (adminId === actor.id) {
      return jsonError(
        "you cannot change your own role or deactivate yourself — ask another OWNER",
        403,
      );
    }

    const roleRaw = optionalString(body, "role", 8);
    const role = roleRaw ? parseRole(roleRaw) : undefined;
    const active = optionalBool(body, "active");
    const label = optionalString(body, "label", 120);
    if (role === undefined && active === undefined && label === undefined) {
      throw new AdminInputError("nothing to update");
    }

    const target = await prisma.adminUser.findUnique({
      where: { id: adminId },
      select: {
        id: true,
        walletAddress: true,
        role: true,
        active: true,
        label: true,
      },
    });
    if (!target) return jsonError("admin not found", 404);

    const changes: string[] = [];
    if (role !== undefined && role !== target.role) {
      changes.push(`role: ${target.role} -> ${role}`);
    }
    if (active !== undefined && active !== target.active) {
      changes.push(`active: ${target.active} -> ${active}`);
    }
    if (label !== undefined && label !== target.label) {
      changes.push(`label: ${target.label ?? "—"} -> ${label || "—"}`);
    }
    if (changes.length === 0) return jsonOk({ ok: true, changed: 0 });

    await prisma.$transaction(async (tx) => {
      await tx.adminUser.update({
        where: { id: adminId },
        data: {
          ...(role !== undefined ? { role } : {}),
          ...(active !== undefined ? { active } : {}),
          ...(label !== undefined ? { label: label || null } : {}),
        },
      });

      const owners = await tx.adminUser.count({
        where: { role: AdminRole.OWNER, active: true },
      });
      if (owners < 1) {
        throw new AdminInputError(
          "refusing: that change would leave the console with no active OWNER",
        );
      }

      await logAdminActionTx(tx, {
        adminId: actor.id,
        action: "admin.update",
        targetType: "AdminUser",
        targetId: adminId,
        detail: `${target.walletAddress}: ${changes.join("; ")}`,
        ip,
      });
    });

    return jsonOk({ ok: true, changed: changes.length, changes });
  } catch (e) {
    return adminErrorResponse(e);
  }
}
