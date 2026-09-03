import { NextResponse } from "next/server";
import { fetchMarks } from "@/lib/cota/sim/prices";

// ---------------------------------------------------------------------------
// The markets a Cota may name, with their current mid price.
//
// Proxied through the server rather than fetched from the browser for one
// reason that matters: the list a player picks from must be the list the
// simulator can price. Hardcoding market names here would let somebody sign a
// bound naming a market that does not exist, which verifies perfectly and then
// authorises nothing — a bound that looks live and is not.
//
// Public data, no authentication, and nothing here can move value.
// ---------------------------------------------------------------------------

export const revalidate = 30;

export async function GET() {
  try {
    const marks = await fetchMarks();
    return NextResponse.json({
      markets: marks.map((m) => ({
        market: m.market,
        // String, not a number: these are e6 integers and JSON numbers lose
        // precision above 2^53. The UI formats them; it never does arithmetic.
        midUsdE6: m.midUsdE6.toString(),
      })),
    });
  } catch (err) {
    console.error("[cota/markets] upstream failed", err);
    // An empty list is not returned on failure. The page must be able to tell
    // "the venue lists no markets" apart from "we could not reach the venue",
    // because only one of those is a reason to hide the sign button.
    return NextResponse.json(
      { error: "could not reach the venue" },
      { status: 502 },
    );
  }
}
