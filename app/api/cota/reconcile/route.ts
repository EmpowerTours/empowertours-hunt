import { NextResponse } from "next/server";
import { AuthError, requirePlayer } from "@/lib/auth";
import { loadPerpKey } from "@/lib/cota/keystore";
import { MON_MARKET } from "@/lib/cota/order";
import { readMark } from "@/lib/cota/venue/market-data";
import { readAccountPositions } from "@/lib/cota/venue/account-read";
import { planAdoption } from "@/lib/cota/venue/adopt";
import { foldFills } from "@/lib/cota/venue/pnl";
import type { MarkedMarket } from "@/lib/cota/venue/account-state";
import { loadFills, recordFills, resolveOrders } from "@/lib/cota/ledger";

// ---------------------------------------------------------------------------
// POST /api/cota/reconcile — adopt a position the ledger has no fills for, on
// the hunter's explicit say-so.
//
// The automatic path (lib/cota/day-state.ts) adopts only what one of this
// agent's own accepted orders accounts for. Everything else stops the executor,
// which is correct: a position the agent did not place could carry losses the
// daily-loss ceiling would otherwise never see.
//
// But "correct" is not "finished". A hunter whose first fill landed after the
// placing socket closed is stuck behind a refusal with no way through, and the
// answer cannot be "close a position at a loss to reset the books". So this
// route exists, and it is deliberately a POST the hunter has to trigger: a
// person decides to take responsibility for size the agent cannot vouch for.
//
// What it will NOT do, at any hunter's request (see adopt.ts): price an
// adoption at anything but the venue's own `ep`, invent a price for a position
// the venue no longer reports, or touch a market whose mark is unknown. It
// records what the venue says is there, or it records nothing.
//
// The honest cost, stated here because the UI states it too: adopting an open
// position starts its loss clock from the venue's entry price. Realised losses
// taken before this moment — a closed trade earlier in the day — are not in the
// ledger and this does not recover them. It resumes trading; it does not
// reconstruct history.
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  try {
    const player = await requirePlayer(req);

    const cred = await loadPerpKey(player.id);
    if (!cred) {
      return NextResponse.json(
        { error: "no trading key — authorize one first" },
        { status: 409 },
      );
    }

    const market = MON_MARKET;
    const markUsd = await readMark(market.id, market.priceDecimals);
    const marks = new Map<number, MarkedMarket>([
      [market.id, { market, markUsd }],
    ]);

    const read = await readAccountPositions({
      apiKey: cred.apiKey,
      secretHex: cred.secretHex,
    });
    const fills = await loadFills(player.id, cred.account);

    const plan = planAdoption({
      fold: foldFills(fills).positions,
      venue: read.positions,
      marks,
      pending: [],
      nowMs: Date.now(),
      trust: "hunter",
    });

    if (plan.fills.length > 0) {
      await recordFills(player.id, cred.account, plan.fills);
      await resolveOrders(plan.resolvedOrderIds);
    }

    return NextResponse.json({
      adopted: plan.fills.map((f) => ({
        marketId: f.marketId,
        direction: f.direction,
        sizeUnits: f.sizeUnits,
        entryUsd: f.priceUsd,
        feeUsd: f.feeUsd,
      })),
      // Anything still here could not be adopted honestly — a position the
      // venue no longer prices, or size the ledger holds and the venue does not.
      unexplained: plan.unexplained,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    console.error("[cota/reconcile] failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}
