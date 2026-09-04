import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db/prisma";
import {
  sendApprovedPayout,
  findUnresolvedPayout,
  type SendResult,
  sweepApprovedPayouts,
} from "@/lib/hunt/payout";

// The keeper. Sweeps APPROVED payouts and broadcasts them, one nonce at a time.
//
// HOW THIS IS DRIVEN: a GitHub Actions workflow on a schedule, hitting this URL
// with the bearer token. NOT railway.json — a `cron` array there is not part of
// the schema and is silently ignored, so entries in it never fire and the queue
// quietly stops draining with no error anywhere.
//
//   # .github/workflows/keeper.yml
//   on:
//     schedule: [{ cron: "*/5 * * * *" }]
//     workflow_dispatch:
//   jobs:
//     sweep:
//       runs-on: ubuntu-latest
//       steps:
//         - run: |
//             curl -fsS -X POST "$HUNT_URL/api/cron/payouts" \
//               -H "Authorization: Bearer $CRON_SECRET"
//           env:
//             HUNT_URL: ${{ vars.HUNT_URL }}
//             CRON_SECRET: ${{ secrets.CRON_SECRET }}
//
// Everything irreversible in here is bounded before it gets here: the amount by
// the per-payout cap, the day by the rolling caps, the hunt by its budget, and
// the release itself by the approval policy or a person. This route adds three
// more bounds of its own:
//
//   * it stops the whole sweep the moment any row is unresolved, because a
//     nonce that may or may not be spent makes every subsequent nonce a guess;
//   * it sends strictly serially, one row at a time;
//   * it takes a batch limit, so one bad configuration cannot drain the
//     treasury in a single invocation.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Never more than this many sends per invocation, whatever the queue holds. */
const MAX_BATCH = 25;

/**
 * Constant-time bearer check.
 *
 * Both sides are hashed first so the comparison is over two equal-length
 * buffers: `timingSafeEqual` throws on a length mismatch, and catching that
 * throw would leak the secret's length one request at a time.
 */
function authorized(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  // Refuse to run rather than run unauthenticated. An unset secret on a route
  // that spends money must fail closed.
  if (!expected || expected.length < 16) return false;

  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (presented.length === 0) return false;

  return timingSafeEqual(
    createHash("sha256").update(presented).digest(),
    createHash("sha256").update(expected).digest(),
  );
}

interface SweepRow {
  payoutId: string;
  ok: boolean;
  status?: string;
  txHash?: string;
  error?: string;
}

export async function POST(req: Request) {
  if (!process.env.CRON_SECRET) {
    console.error("[cron/payouts] CRON_SECRET is not set; refusing to run");
    return NextResponse.json(
      { error: "cron is not configured" },
      { status: 503 },
    );
  }
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = await sweepApprovedPayouts(MAX_BATCH);

  // Same 409 as before: an unresolved broadcast blocks the whole treasury, and
  // the caller needs a status it can alert on rather than a 200 saying nothing
  // was swept.
  if (result.blockedBy) {
    return NextResponse.json(
      {
        swept: 0,
        halted: result.halted,
        payoutId: result.blockedBy.payoutId,
        status: result.blockedBy.status,
        nonce: result.blockedBy.nonce,
        detail:
          "a previous broadcast has an unknown outcome; resolve it against the chain before sending anything else",
      },
      { status: 409 },
    );
  }

  return NextResponse.json(result);
}
