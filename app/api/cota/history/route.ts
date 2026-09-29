import { NextResponse } from "next/server";
import { AuthError, requirePlayer } from "@/lib/auth";
import { prisma } from "@/lib/db/prisma";
import { MON_MARKET } from "@/lib/cota/order";
import { tripsFromFills } from "@/lib/cota/venue/trips";
import type { LedgerFill } from "@/lib/cota/venue/pnl";

// ---------------------------------------------------------------------------
// GET /api/cota/history — what this hunter's trades actually made.
//
// WHY IT IS SEPARATE FROM /api/cota/risk. Risk answers "how exposed am I NOW",
// and to do that it opens a socket to Perpl, needs a live leash and a stored
// API key, and returns `{ leash: null }` the moment either is missing. All
// correct for its question, and all fatal for this one: a hunter whose position
// is closed and whose leash has expired is exactly the person asking what they
// made, and risk tells them nothing at all. That is how four real fills and a
// 35-cent profit sat in the database for two weeks with no screen that could
// show them.
//
// So this reads the ledger and nothing else. No socket, no key, no leash. It
// answers after a revoke, after an expiry, and while the venue is down — and
// what it reports is our own record of what was executed, which is the thing
// that survives all three.
//
// SCOPED BY (player, account), like the ledger itself. A hunter who re-enrolled
// on a second Perpl account has two separate ledgers and gets two, because
// folding them would produce a position neither account ever held.
// ---------------------------------------------------------------------------

/** Symbol for a market id. Only MON trades today; an unknown id says so rather
 *  than borrowing MON's name. */
function symbolFor(marketId: number): string {
  return marketId === MON_MARKET.id ? MON_MARKET.symbol : `#${marketId}`;
}

export async function GET(req: Request) {
  try {
    const player = await requirePlayer(req);

    const rows = await prisma.cotaFill.findMany({
      where: { playerId: player.id },
      orderBy: { filledAt: "asc" },
    });

    // Group by account BEFORE folding. Two accounts' fills netted together
    // would describe a position that never existed on either.
    const byAccount = new Map<string, LedgerFill[]>();
    for (const r of rows) {
      const fill: LedgerFill = {
        marketId: r.marketId,
        direction: r.direction === -1 ? -1 : 1,
        sizeUnits: r.sizeUnits,
        priceUsd: r.priceUsd,
        feeUsd: r.feeUsd,
        timestampMs: r.filledAt.getTime(),
        orderId: r.orderId,
        source:
          r.source === "observed" || r.source === "adopted"
            ? r.source
            : undefined,
      };
      const list = byAccount.get(r.account);
      if (list) list.push(fill);
      else byAccount.set(r.account, [fill]);
    }

    const accounts = [...byAccount.entries()].map(([account, fills]) => {
      const led = tripsFromFills(fills);
      return {
        account,
        realisedUsd: led.realisedUsd,
        feesUsd: led.feesUsd,
        closed: led.closed,
        open: led.open,
        fillCount: fills.length,
        // Some rows were reconstructed by differencing our ledger against the
        // venue's lifetime total rather than observed on the wire. The prices
        // are right; the timestamps are the reconcile moment. Said out loud
        // here so a screen can mark the row instead of implying we watched it.
        adopted: fills.filter((f) => f.source === "adopted").length,
        unknownSource: fills.filter((f) => f.source === undefined).length,
        trips: led.trips.map((t) => ({
          ...t,
          market: symbolFor(t.marketId),
          // Return on what was put in. Undefined for an open trip, where the
          // denominator is money still at risk.
          netPct:
            t.open || t.entryUsd <= 0
              ? null
              : (t.netUsd / (t.entryUsd * t.units)) * 100,
        })),
      };
    });

    return NextResponse.json({
      accounts,
      // The totals a hunter reads first. Summed across accounts, which is fine
      // for money in a way it is not for positions.
      realisedUsd: accounts.reduce((s, a) => s + a.realisedUsd, 0),
      feesUsd: accounts.reduce((s, a) => s + a.feesUsd, 0),
      fillCount: rows.length,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    console.error("[cota/history] failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}
