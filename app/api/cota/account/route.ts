import { NextResponse } from "next/server";
import { AuthError, requirePlayer } from "@/lib/auth";
import { loadPerpKey } from "@/lib/cota/keystore";
import { readAccountPositions } from "@/lib/cota/venue/account-read";
import { EXECUTABLE_MARKETS } from "@/lib/cota/order";
import { readLossCheckInputs } from "@/lib/cota/venue/market-data";
import {
  addBlockedByLoss,
  describePositions,
} from "@/lib/cota/venue/position-view";

// ---------------------------------------------------------------------------
// GET /api/cota/account — what the hunter already has AT PERPL.
//
// WHY THIS EXISTS. /cota/deposit showed "AUSD available: 0" and meant "in your
// wallet". That is true and reads as "my money is gone" to somebody who has
// already deposited, because their AUSD is sitting at Perpl as collateral —
// a different balance entirely, which no screen showed. A tester hit exactly
// that and concluded the app had lost their funds.
//
// /api/cota/risk already reads this, but it answers `{leash: null}` and stops
// when there is no live leash — and the person asking "where is my AUSD" is
// very often the person who has not signed one yet. So this asks for less: a
// stored venue key, nothing about leashes.
// ---------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const player = await requirePlayer(req);
    const cred = await loadPerpKey(player.id);
    // No key is not an error: it is the normal state before enrolling, and the
    // screen renders it as "no Perpl account yet" rather than as a failure.
    if (!cred) return NextResponse.json({ enrolled: false, account: null });

    const read = await readAccountPositions({
      apiKey: cred.apiKey,
      secretHex: cred.secretHex,
    });
    if (!read.account) {
      // Reached the venue and it told us nothing. Null, never zero — a zero
      // here would be the same lie this route exists to stop.
      return NextResponse.json({ enrolled: true, account: null });
    }

    const positions = describePositions(read.positions);
    // Whether Perpl will settle an order ADDING to what is open on MON, the
    // market one-click trades. One context read, only when something is open.
    const mon = EXECUTABLE_MARKETS.MON;
    let addCheck: ReturnType<typeof addBlockedByLoss> = { blocked: false };
    if (positions.some((p) => p.market === mon.symbol)) {
      const { markUsd, limitBps } = await readLossCheckInputs(
        mon.id,
        mon.priceDecimals,
      );
      addCheck = addBlockedByLoss({
        positions,
        market: mon.symbol,
        markUsd,
        limitBps,
      });
    }

    return NextResponse.json({
      enrolled: true,
      account: {
        accountId: read.account.accountId,
        // Perpl reports collateral in USD at 1e6. AUSD is the collateral
        // asset, so these are AUSD figures to the hunter.
        balanceUsd: read.account.balance / 1e6,
        lockedUsd: read.account.locked / 1e6,
        availableUsd: read.account.available / 1e6,
        forwardingAllowed: read.account.forwardingAllowed,
        frozen: read.account.frozen,
        // Open positions hold margin the order form cannot spend. Shown so a
        // hunter never has to go to app.perpl.xyz to find out what is open.
        positions,
        // Can one-click add to the open MON position? See addBlockedByLoss.
        addCheck,
      },
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    console.error("[cota/account] failed", err);
    // The deposit screen must still render; it shows the wallet balance and
    // says the Perpl side could not be read.
    return NextResponse.json({ error: "venue unreachable" }, { status: 502 });
  }
}
