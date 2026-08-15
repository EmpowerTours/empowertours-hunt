// Treasury numbers, for the dashboard's live refresh. VIEWER.
//
// Every wei value is serialised as a decimal STRING. JSON numbers are IEEE
// doubles, so `JSON.stringify(1000000000000000000n)` is not even legal and
// `Number(wei)` would round — the client must receive strings and keep them
// as strings.

import { AdminRole } from "@prisma/client";
import { requireAdminApi } from "@/lib/admin/auth";
import { treasurySnapshot } from "@/lib/admin/queries";
import { readTreasuryBalance } from "@/lib/admin/treasury";
import { adminErrorResponse, jsonOk } from "@/lib/admin/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAdminApi(AdminRole.VIEWER);

    const [snapshot, balance] = await Promise.all([
      treasurySnapshot(),
      readTreasuryBalance(),
    ]);

    const owed = snapshot.pendingWei + snapshot.approvedWei;

    return jsonOk({
      treasury: {
        address: balance.address,
        balanceWei: balance.balanceWei?.toString() ?? null,
        error: balance.error,
      },
      liability: {
        pendingWei: snapshot.pendingWei.toString(),
        pendingCount: snapshot.pendingCount,
        approvedWei: snapshot.approvedWei.toString(),
        approvedCount: snapshot.approvedCount,
        owedWei: owed.toString(),
        inFlightWei: snapshot.inFlightWei.toString(),
        inFlightCount: snapshot.inFlightCount,
        needsReconciliationCount: snapshot.needsReconciliationCount,
        covered:
          balance.balanceWei === null ? null : balance.balanceWei >= owed,
      },
      flow: {
        sent24hWei: snapshot.sent24hWei.toString(),
        autoApproved24hWei: snapshot.autoApproved24hWei.toString(),
        autoApprovedAllTimeWei: snapshot.autoApprovedAllTimeWei.toString(),
      },
      credit: {
        issuedWei: snapshot.creditIssuedWei.toString(),
        outstandingWei: snapshot.creditOutstandingWei.toString(),
      },
      hunts: snapshot.hunts.map((h) => ({
        id: h.id,
        name: h.name,
        active: h.active,
        spawnEnabled: h.spawnEnabled,
        budgetMonWei: h.budgetMonWei.toString(),
        spentMonWei: h.spentMonWei.toString(),
        budgetCreditWei: h.budgetCreditWei.toString(),
        spentCreditWei: h.spentCreditWei.toString(),
        autoApproveMaxWei: h.autoApproveMaxWei.toString(),
        autoApproveDailyCapWei: h.autoApproveDailyCapWei.toString(),
        autoApproved24hWei: h.autoApproved24hWei.toString(),
      })),
    });
  } catch (e) {
    return adminErrorResponse(e);
  }
}
