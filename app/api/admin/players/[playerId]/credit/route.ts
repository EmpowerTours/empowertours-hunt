// Manual TURBO credit adjustment. OPERATOR.
//
// Credit is denominated in WMON-wei and is NOT withdrawable — this grants or
// revokes a subscription discount, not cash. It still moves margin, so it is
// bounded and audited like anything else.
//
// The ledger is the source of truth and it is append-only: a revocation is a
// new negative row, never an edit of the row that granted it. The balance
// column on Player is a cache of that ledger, so both are written in one
// transaction and the audit row commits with them.
//
// The decrement is a conditional UPDATE guarded on the balance being large
// enough, with the affected-row count checked. A read-then-write here would
// let two concurrent revocations both observe the same balance and drive it
// negative — a balance that cannot be reconciled against the ledger.

import { AdminRole, CreditReason, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { requestIp, requireAdminApi } from "@/lib/admin/auth";
import { logAdminActionTx } from "@/lib/admin/audit";
import { fromWei, parseMonInput } from "@/lib/wei";
import { weiOf } from "@/lib/admin/format";
import {
  AdminInputError,
  adminErrorResponse,
  jsonOk,
  optionalString,
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
    const direction = requireString(body, "direction", { min: 5, max: 6 });
    if (direction !== "GRANT" && direction !== "REVOKE") {
      throw new AdminInputError("direction must be GRANT or REVOKE");
    }
    // parseMonInput refuses "1e18", "0x10", blanks, padded strings, negatives
    // and anything finer than 18dp. Those all survive BigInt() as either a
    // throw mid-transaction or a catastrophically wrong number.
    const amountWei = parseMonInput(
      requireString(body, "amount", { min: 1, max: 40 }),
    );
    if (amountWei <= 0n) {
      throw new AdminInputError("amount must be greater than zero");
    }
    const note = requireString(body, "note", { min: 6, max: 500 });
    const huntId = optionalString(body, "huntId", 64);

    const result = await prisma.$transaction(async (tx) => {
      if (direction === "GRANT") {
        const bumped = await tx.player.updateMany({
          where: { id: playerId },
          data: {
            creditBalanceWei: {
              increment: new Prisma.Decimal(fromWei(amountWei)),
            },
          },
        });
        if (bumped.count === 0) throw new AdminInputError("player not found");
      } else {
        // Ceiling check and write in one statement: the balance must already
        // cover the revocation or nothing changes.
        const debited = await tx.player.updateMany({
          where: {
            id: playerId,
            creditBalanceWei: { gte: new Prisma.Decimal(fromWei(amountWei)) },
          },
          data: {
            creditBalanceWei: {
              decrement: new Prisma.Decimal(fromWei(amountWei)),
            },
          },
        });
        if (debited.count === 0) {
          throw new AdminInputError(
            "player does not hold that much credit — revoke at most their current balance",
          );
        }
      }

      const after = await tx.player.findUniqueOrThrow({
        where: { id: playerId },
        select: { creditBalanceWei: true },
      });
      const balanceAfter = weiOf(after.creditBalanceWei);
      const signed = direction === "GRANT" ? amountWei : -amountWei;

      await tx.creditLedger.create({
        data: {
          playerId,
          huntId: huntId ?? null,
          reason:
            direction === "GRANT"
              ? CreditReason.ADMIN_GRANT
              : CreditReason.ADMIN_REVOKE,
          amountWei: new Prisma.Decimal(
            signed < 0n ? `-${fromWei(-signed)}` : fromWei(signed),
          ),
          balanceAfterWei: new Prisma.Decimal(fromWei(balanceAfter)),
          note,
          actorId: admin.id,
        },
      });

      await logAdminActionTx(tx, {
        adminId: admin.id,
        action: "player.credit.adjust",
        targetType: "Player",
        targetId: playerId,
        detail: `${direction} ${amountWei} wei (WMON) — ${note}`,
        ip,
      });

      return { balanceAfter };
    });

    return jsonOk({ ok: true, balanceWei: result.balanceAfter.toString() });
  } catch (e) {
    return adminErrorResponse(e);
  }
}
