import { NextResponse } from "next/server";
import { parseBook } from "@/lib/cota/kuru-book";

// ---------------------------------------------------------------------------
// GET /api/cota/kuru/book — Kuru's MON/USDC order book.
//
// A proxy exists for one reason: exchange.kuru.io answers a GET with no
// Access-Control-Allow-Origin, so a browser cannot read it. ws.kuru.io (the
// quote API) does send it and is called directly from the page — there is no
// proxy there and adding one would only put us between a hunter and their own
// quote.
//
// Unauthenticated on purpose. This is a public order book, the same numbers
// anyone can read from Kuru or from the chain; requiring a session to see a
// price would be theatre. It takes no user input at all — the symbol is fixed
// below rather than accepted from the query string, so this cannot be pointed
// at an arbitrary host or used to probe their API.
//
// Parsed here rather than forwarded raw, so the 1e18/1e10 scaling trap is
// applied once in tested code instead of in every caller.
// ---------------------------------------------------------------------------

const SYMBOL = "MON_USDC";
const UPSTREAM = "https://exchange.kuru.io/api/v3/depth";

export async function GET(): Promise<NextResponse> {
  try {
    const res = await fetch(`${UPSTREAM}?symbol=${SYMBOL}&limit=15`, {
      // Never a cached book. A stale one is worse than none: it reads as a
      // live market and prices a trade that cannot fill.
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `kuru depth ${res.status}` },
        { status: 502 },
      );
    }
    const book = parseBook(await res.json());
    if (book.bestBidUsd === null || book.bestAskUsd === null) {
      // An empty side is not an outage, but it is not a tradable book either,
      // and the screen must be able to tell those apart.
      return NextResponse.json(
        { error: "one side of the book is empty", book },
        { status: 503 },
      );
    }
    return NextResponse.json({ symbol: SYMBOL, ...book });
  } catch {
    return NextResponse.json({ error: "kuru unreachable" }, { status: 502 });
  }
}
