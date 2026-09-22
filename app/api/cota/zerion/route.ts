import { NextResponse } from "next/server";
import { AuthError, requirePlayer } from "@/lib/auth";
import { fetchHoldings, ZerionError } from "@/lib/cota/zerion";

// ---------------------------------------------------------------------------
// GET /api/cota/zerion — what the caller's own wallet holds.
//
// THE ADDRESS IS NOT A PARAMETER, deliberately. It comes from the session, so
// this route reads one wallet: yours. Accepting an address would turn a
// keyed, rate-limited account into a public wallet-lookup service on our quota,
// and would let anyone point it at anyone.
//
// A FAILURE IS NOT AN EMPTY WALLET. Zerion being down, unkeyed or slow all
// return 503 rather than `{holdings: []}`, because a hunter who just deposited
// and sees "nothing" will conclude their money is gone. The screen renders
// nothing at all in that case, which is the honest shape of not knowing.
// ---------------------------------------------------------------------------

export async function GET(req: Request) {
  try {
    const player = await requirePlayer(req);
    const holdings = await fetchHoldings(player.walletAddress);
    return NextResponse.json({ holdings });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (err instanceof ZerionError) {
      const unconfigured = /is not set/.test(err.message);
      return NextResponse.json(
        { error: unconfigured ? "unconfigured" : "upstream" },
        { status: 503 },
      );
    }
    throw err;
  }
}
