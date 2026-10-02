import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { CONTEST_WINDOW, monMoved, type Window } from "@/lib/cota/mon-moved";

// ---------------------------------------------------------------------------
// MON moved per wallet, for the contest that scores it.
//
// DATABASE ONLY. No Perpl socket, no trading key, no leash — every figure it
// serves was written by the executor or decoded off the chain at record time,
// so nothing here can place an order and nothing needs an authenticated venue
// session to answer. That is deliberate: a leaderboard is the most-loaded page
// during a contest, and a page that needed a key would couple the one thing
// everybody refreshes to the one thing that must never be rate-limited out.
//
// Unauthenticated, for the same reason /api/cota/kuru/history is: every row is
// already on a public chain, so serving it discloses nothing an explorer would
// not, and a judge or a rival can check our own number against Monad.
// ---------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A window parsed from the query, or the contest's own. */
function windowFrom(url: URL): { window: Window; custom: boolean } {
  const f = url.searchParams.get("from");
  const t = url.searchParams.get("to");
  if (!f || !t) return { window: CONTEST_WINDOW, custom: false };
  const from = new Date(f);
  const to = new Date(t);
  // An unparseable date yields NaN, and every comparison against NaN is false,
  // so a typo would silently return an empty leaderboard rather than an error.
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return { window: CONTEST_WINDOW, custom: false };
  }
  if (!(from < to)) return { window: CONTEST_WINDOW, custom: false };
  return { window: { from, to }, custom: true };
}

export async function GET(req: Request) {
  const { window, custom } = windowFrom(new URL(req.url));

  // Filtered in SQL rather than in the fold. The fold re-checks the window
  // anyway — it has to, being pure and testable — but fetching a year of rows
  // to discard them is a different cost.
  const [spot, perp] = await Promise.all([
    prisma.kuruSwap.findMany({
      where: { at: { gte: window.from, lt: window.to } },
      select: {
        wallet: true,
        ok: true,
        valueWei: true,
        nativeInWei: true,
        at: true,
      },
    }),
    prisma.cotaFill.findMany({
      where: { filledAt: { gte: window.from, lt: window.to } },
      select: {
        account: true,
        marketId: true,
        sizeUnits: true,
        filledAt: true,
      },
    }),
  ]);

  const standings = monMoved(spot, perp, window);

  return NextResponse.json({
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    custom,
    standings: standings.map((s) => ({
      wallet: s.wallet,
      // Wei as decimal strings. JSON cannot carry a bigint, and a client that
      // has to reconcile against the chain needs the exact figure, not a float.
      spotSoldWei: s.spotSoldWei.toString(),
      spotBoughtWei: s.spotBoughtWei.toString(),
      perpUnits: s.perpUnits,
      totalMon: s.totalMon,
      unresolvedBuys: s.unresolvedBuys,
      complete: s.complete,
    })),
    // The honest headline. Summed from the same standings so it cannot drift
    // from the rows underneath it.
    totalMon: standings.reduce((a, s) => a + s.totalMon, 0),
    anyIncomplete: standings.some((s) => !s.complete),
  });
}
