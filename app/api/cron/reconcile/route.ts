import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { reconcileOutstandingPayouts } from "@/lib/hunt/payout";

// The recovery path for an ambiguous send.
//
// A payout is left SENDING or NEEDS_RECONCILIATION whenever the broadcast, or
// the wait for its receipt, ended without an answer. The ONLY correct way out
// of that state is to ask the chain what happened to (treasury, nonce). This
// route does that and nothing else — it never constructs a wallet client, so it
// structurally cannot send a transaction.
//
// What it decides, and what it deliberately refuses to decide:
//
//   hash mined, success        -> SENT
//   hash mined, reverted       -> stays NEEDS_RECONCILIATION. A human looks at
//                                 a native transfer that reverted.
//   hash not mined, nonce free -> UNCHANGED. It is still in the mempool. Saying
//                                 "never happened" here is how a payout gets
//                                 re-approved and then mines twice.
//   no hash, nonce unconsumed
//   in BOTH latest and pending -> FAILED, txHash NULL. Only now is
//                                 "the broadcast never landed" a fact, and only
//                                 a FAILED row with no hash may be re-approved
//                                 by a person.
//   no hash, nonce consumed    -> NEEDS_RECONCILIATION with what we know. A
//                                 person finishes it via the admin lane, which
//                                 demands written evidence.
//
// Driven by GitHub Actions on a schedule, like /api/cron/payouts — railway.json
// has no `cron` array, and entries placed there are silently ignored.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected || expected.length < 16) return false;

  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (presented.length === 0) return false;

  // Hashed first so both buffers are the same length: timingSafeEqual throws
  // on a mismatch, and that throw would leak the secret's length.
  return timingSafeEqual(
    createHash("sha256").update(presented).digest(),
    createHash("sha256").update(expected).digest(),
  );
}

export async function POST(req: Request) {
  if (!process.env.CRON_SECRET) {
    console.error("[cron/reconcile] CRON_SECRET is not set; refusing to run");
    return NextResponse.json(
      { error: "cron is not configured" },
      { status: 503 },
    );
  }
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const { checked, outcomes } = await reconcileOutstandingPayouts();

    // Anything still unresolved after a pass is a human's job now, and saying
    // so in the response is what makes the alert possible.
    const stillOpen = outcomes.filter(
      (o) => o.to === "NEEDS_RECONCILIATION" || o.to === "UNCHANGED",
    );

    return NextResponse.json({
      checked,
      resolved: outcomes.length - stillOpen.length,
      needsHuman: stillOpen.length,
      outcomes,
    });
  } catch (e) {
    // Fail loudly. A reconciler that swallows its own errors leaves rows in an
    // ambiguous state with nobody told.
    const message = e instanceof Error ? e.message : "unknown error";
    console.error("[cron/reconcile]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
