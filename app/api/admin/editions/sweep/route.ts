// Recover licences the relayer paid for and never delivered.
//
// relayLicense buys, then transfers. Between those two the money is already
// gone and the licence sits with the relayer; anything that throws in the gap
// leaves the hunter with nothing. The claim row has recorded that honestly all
// along (status FAILED, purchaseTxHash set, transferTxHash null) and nothing
// ever acted on it. This is the thing that acts on it.
//
// AN ADMIN ROUTE RATHER THAN A CRON, deliberately. It spends the relayer's gas
// and moves assets, so it gets a human and an audit row rather than running
// unattended. It is also DRY BY DEFAULT: `execute: true` must be sent
// explicitly, and a GET only ever reports.

import { AdminRole } from "@prisma/client";
import { requestIp, requireAdminApi } from "@/lib/admin/auth";
import { logAdminAction } from "@/lib/admin/audit";
import { adminErrorResponse, jsonOk, readJson } from "@/lib/admin/http";
import { sweepStrandedLicences } from "@/lib/editions/sweep";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Enough to clear a backlog, small enough that one click is reviewable. */
const MAX_LIMIT = 25;

/** Report only. Never sends, whatever it is asked. */
export async function GET() {
  try {
    await requireAdminApi(AdminRole.OPERATOR);
    const report = await sweepStrandedLicences({ limit: MAX_LIMIT });
    return jsonOk({ dryRun: true, ...report });
  } catch (e) {
    return adminErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const admin = await requireAdminApi(AdminRole.OPERATOR);
    const ip = await requestIp();
    const body = await readJson(req);

    // Opt in by exact value. A truthy check would let "false" send.
    const execute = body.execute === true;
    const limit =
      typeof body.limit === "number" && body.limit > 0
        ? Math.min(Math.floor(body.limit), MAX_LIMIT)
        : MAX_LIMIT;

    const report = await sweepStrandedLicences({ limit, execute });

    // Logged whether or not anything moved: a dry run that found five stranded
    // licences is itself worth a record.
    await logAdminAction({
      adminId: admin.id,
      action: execute ? "editions.sweep.execute" : "editions.sweep.dry",
      targetType: "EditionClaim",
      targetId: report.transferred.map((t) => t.claimId).join(",") || "-",
      detail: JSON.stringify({
        examined: report.examined,
        transferred: report.transferred.length,
        alreadyDelivered: report.alreadyDelivered.length,
        notHeld: report.notHeld.length,
        unresolved: report.unresolved.length,
      }),
      ip,
    });

    return jsonOk({ dryRun: !execute, ...report });
  } catch (e) {
    return adminErrorResponse(e);
  }
}
