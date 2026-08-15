// Resolve a NEEDS_RECONCILIATION payout against the chain.
//
// THIS IS NOT A RETRY. NEEDS_RECONCILIATION means a transaction was broadcast
// and nobody knows whether it landed. The only safe move is to go and look:
// open the treasury address on MonadScan, find (or fail to find) a transfer of
// this exact amount to this player around this time, and record what you saw.
//
// Written evidence is mandatory and goes into the append-only trail, because
// resolving to FAILED clears txHash — which is what re-opens the
// FAILED -> APPROVED path and makes the payout sendable again. That assertion
// has to be attributable to a person.
//
// Gated at OPERATOR to match the documented role model (OPERATOR approves and
// voids payouts). The protection here is the mandatory evidence and the audit
// row, not a higher role.

import { AdminRole } from "@prisma/client";
import { requestIp, requireAdminApi } from "@/lib/admin/auth";
import { logAdminAction } from "@/lib/admin/audit";
import { reconcilePayout, type ReconcileOutcome } from "@/lib/admin/payouts";
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

export async function POST(
  req: Request,
  ctx: { params: Promise<{ payoutId: string }> },
) {
  try {
    const admin = await requireAdminApi(AdminRole.OPERATOR);
    const { payoutId } = await ctx.params;
    const ip = await requestIp();

    const body = await readJson(req);
    const rawOutcome = requireString(body, "outcome", { min: 4, max: 16 });
    if (rawOutcome !== "SENT" && rawOutcome !== "FAILED") {
      throw new AdminInputError(
        "outcome must be SENT (the transfer is confirmed on chain) or FAILED (no transfer landed)",
      );
    }
    const outcome: ReconcileOutcome = rawOutcome;
    const evidence = requireString(body, "evidence", { min: 10, max: 1000 });
    const txHash = optionalString(body, "txHash", 80);

    const result = await reconcilePayout({
      payoutId,
      adminId: admin.id,
      outcome,
      txHash,
      evidence,
    });

    if (!result.ok) {
      await logAdminAction({
        adminId: admin.id,
        action: "payout.transition.denied",
        targetType: "Payout",
        targetId: payoutId,
        detail: `reconcile(${outcome}) refused: ${result.reason ?? "unknown"}`,
        ip,
      });
      return jsonError(result.reason ?? "reconciliation refused", 409);
    }

    await logAdminAction({
      adminId: admin.id,
      action: "payout.reconcile",
      targetType: "Payout",
      targetId: payoutId,
      detail: `resolved as ${outcome}${txHash ? ` tx=${txHash}` : ""} — ${evidence}`,
      ip,
    });

    return jsonOk({ ok: true, status: result.to });
  } catch (e) {
    return adminErrorResponse(e);
  }
}
