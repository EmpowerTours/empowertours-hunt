// Batch approve.
//
// Convenience for a queue of small spawn payouts, without becoming a way to
// release an unexamined amount of MON in one click:
//
//   * an explicit list of ids — there is no "approve everything matching a
//     filter", because the filter is evaluated on the server against rows the
//     operator never saw;
//   * capped at 100 ids per call;
//   * the client must echo back the total it displayed. The server re-sums the
//     eligible rows and refuses on any mismatch, so a queue that changed
//     between render and click is a 409 rather than a surprise;
//   * each row is still its own conditional UPDATE with a checked row count.
//     A batch is a loop of individually-guarded transitions, never a bulk
//     `updateMany` that would sweep up rows in states it should not touch.

import { AdminRole, PayoutStatus } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { requestIp, requireAdminApi } from "@/lib/admin/auth";
import { logAdminAction } from "@/lib/admin/audit";
import { approvePayout } from "@/lib/admin/payouts";
import { toWei } from "@/lib/wei";
import { weiOf } from "@/lib/admin/format";
import {
  AdminInputError,
  adminErrorResponse,
  jsonOk,
  readJson,
  requireString,
} from "@/lib/admin/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BATCH = 100;

export async function POST(req: Request) {
  try {
    const admin = await requireAdminApi(AdminRole.OPERATOR);
    const ip = await requestIp();
    const body = await readJson(req);

    const rawIds = body.payoutIds;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      throw new AdminInputError("payoutIds must be a non-empty array");
    }
    if (rawIds.length > MAX_BATCH) {
      throw new AdminInputError(
        `at most ${MAX_BATCH} payouts per batch — approve in smaller groups so the total stays legible`,
      );
    }
    const payoutIds = [
      ...new Set(
        rawIds.map((id) => {
          if (typeof id !== "string" || id.length === 0 || id.length > 64) {
            throw new AdminInputError("payoutIds must be strings");
          }
          return id;
        }),
      ),
    ];

    // Wei, not MON: this value comes from the server's own rendering, so it is
    // already in base units. `toWei` still rejects a decimal, a negative or an
    // exponent-formatted string.
    const confirmTotalWei = toWei(
      requireString(body, "confirmTotalWei", { min: 1, max: 80 }),
    );

    // Sum only the rows that are actually eligible, in the same terms the
    // operator was shown.
    const eligible = await prisma.payout.findMany({
      where: {
        id: { in: payoutIds },
        OR: [
          { status: PayoutStatus.PENDING },
          { status: PayoutStatus.FAILED, txHash: null },
        ],
      },
      select: { id: true, amountMonWei: true },
    });

    const actualTotal = eligible.reduce(
      (sum, p) => sum + weiOf(p.amountMonWei),
      0n,
    );
    if (actualTotal !== confirmTotalWei) {
      throw new AdminInputError(
        `the queue changed since it was rendered (eligible total is ${actualTotal} wei, you confirmed ${confirmTotalWei} wei). Refresh and review again.`,
      );
    }

    const approved: string[] = [];
    const refused: Array<{ id: string; reason: string }> = [];
    for (const payoutId of payoutIds) {
      const result = await approvePayout({ payoutId, adminId: admin.id });
      if (result.ok) approved.push(payoutId);
      else refused.push({ id: payoutId, reason: result.reason ?? "refused" });
    }

    await logAdminAction({
      adminId: admin.id,
      action: "payout.approve.batch",
      targetType: "Payout",
      // The batch has no single target; the ids are enumerated in the detail,
      // and each row also gets its own per-payout row below.
      targetId: `batch:${approved.length}`,
      detail: `approved ${approved.length}/${payoutIds.length} totalling ${actualTotal} wei; ids=${approved.join(",")}; refused=${refused.map((r) => `${r.id}:${r.reason}`).join(" | ")}`,
      ip,
    });
    for (const payoutId of approved) {
      await logAdminAction({
        adminId: admin.id,
        action: "payout.approve",
        targetType: "Payout",
        targetId: payoutId,
        detail: "released as part of a batch approval",
        ip,
      });
    }

    return jsonOk({
      ok: true,
      approved: approved.length,
      refused,
      totalWei: actualTotal.toString(),
    });
  } catch (e) {
    return adminErrorResponse(e);
  }
}
