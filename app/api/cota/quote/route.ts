import { NextResponse } from "next/server";
import { executableMarket } from "@/lib/cota/order";
import { readQuote } from "@/lib/cota/venue/market-data";
import { fetchPriceHistory, type PriceHistory } from "@/lib/cota/price-history";

// ---------------------------------------------------------------------------
// GET /api/cota/quote?market=MON — the price the order form was missing.
//
// WHY IT EXISTS. The form asked for a side, a size in dollars and a leverage,
// and showed no price. A hunter sized a position with nothing on screen saying
// what the thing cost, what spread they would cross, or what a move would do
// to them. Everything needed was already being read elsewhere for other
// reasons; none of it reached the screen where the decision is made.
//
// BOOK, NOT MARK. Both are returned and they are NOT interchangeable. The mark
// is an index — on MON it has been observed below the bid — and nobody can fill
// there. The entry and exit arithmetic uses the ask and the bid, and the mark
// is carried for reference only.
//
// PUBLIC, like /api/cota/markets. It proxies Perpl's public context endpoint,
// takes no key and can move nothing. It is proxied rather than fetched from the
// browser so the page cannot be pointed at a different venue by whoever
// controls the client, and so the two caches below exist at all.
//
// TWO CACHES, TWO REASONS. The book is memoised for seconds because the form
// polls it and several tabs must not each hammer the venue. The history is
// memoised for minutes because CoinGecko's free tier rate-limits, and a 429
// there would take the price strip down with it.
// ---------------------------------------------------------------------------

interface Cached<T> {
  at: number;
  value: T;
}

// Containers rather than bare `let`s: reassigning a module-level binding after
// an await is the `require-atomic-updates` footgun, and a field write is not.
const store: {
  quote: Map<string, Cached<Awaited<ReturnType<typeof readQuote>>>>;
  history: Map<string, Cached<PriceHistory | null>>;
} = { quote: new Map(), history: new Map() };

const QUOTE_TTL_MS = 4_000;
const HISTORY_TTL_MS = 5 * 60_000;

async function remember<T>(
  bucket: Map<string, Cached<T>>,
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
): Promise<T> {
  const hit = bucket.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await load();
  bucket.set(key, { at: Date.now(), value });
  return value;
}

export async function GET(req: Request) {
  const symbol = new URL(req.url).searchParams.get("market");
  if (!symbol) {
    return NextResponse.json({ error: "market required" }, { status: 400 });
  }

  // Only markets this executor can actually reach. Quoting one we cannot trade
  // would put a live price under a button that can only ever fail.
  const market = executableMarket(symbol);
  if (!market) {
    return NextResponse.json({ error: "unknown market" }, { status: 404 });
  }

  try {
    const [quote, history] = await Promise.all([
      remember(store.quote, symbol, QUOTE_TTL_MS, () =>
        readQuote(market.id, market.priceDecimals),
      ),
      remember(store.history, symbol, HISTORY_TTL_MS, () =>
        // Context for the eye, never for the arithmetic: this is CoinGecko's
        // spot series, not the venue's book.
        fetchPriceHistory(symbol).catch(() => null),
      ),
    ]);

    if (!quote) {
      // Explicitly distinguishable from "the book is empty". The page must be
      // able to say "we could not read the venue" rather than draw a flat market.
      return NextResponse.json(
        { error: "could not reach the venue" },
        { status: 502 },
      );
    }

    return NextResponse.json({
      market: market.symbol,
      markUsd: quote.markUsd,
      bidUsd: quote.bidUsd,
      askUsd: quote.askUsd,
      // Null when either side is missing — a spread computed against a missing
      // side would read as zero, which is the most flattering possible lie.
      spreadBps:
        quote.bidUsd !== null && quote.askUsd !== null && quote.bidUsd > 0
          ? ((quote.askUsd - quote.bidUsd) /
              ((quote.askUsd + quote.bidUsd) / 2)) *
            10_000
          : null,
      history,
    });
  } catch (err) {
    console.error("[cota/quote] failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}
