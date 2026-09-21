// ---------------------------------------------------------------------------
// Kuru's order book, parsed.
//
// TWO DIFFERENT SCALES IN ONE ROW, which is the whole reason this is a module
// and not three lines inline. A level arrives as ["25371000000000000",
// "100140000000000"] and those are NOT the same fixed point: the price is 1e18
// and the size is 1e10. Read the size as 1e18 and a $254 level reads as
// 0.00001 MON — a book that looks empty when it is deep, which is exactly the
// direction that makes someone refuse a trade they should have taken.
//
// The AMM-backed symbols (MON_USDC_V4_5 and friends) answer the same endpoint
// with a different thing entirely — cumulative size/average price curves as
// plain decimal strings, not levels. Feeding those to this parser produces
// numbers rather than an error, so only CLOB symbols belong here.
//
// Prices come back as USDC per MON. Both legs are 6dp tokens, so a price is
// just a price; no decimal adjustment is owed.
// ---------------------------------------------------------------------------

const PRICE_SCALE = 1e18;
const SIZE_SCALE = 1e10;

export interface BookLevel {
  /** USDC per MON. */
  priceUsd: number;
  /** MON resting at this level. */
  sizeMon: number;
  /** priceUsd * sizeMon — what the level is worth, which is what depth means. */
  notionalUsd: number;
}

export interface KuruBook {
  bids: BookLevel[];
  asks: BookLevel[];
  /** Best bid and ask, or null when that side is empty. */
  bestBidUsd: number | null;
  bestAskUsd: number | null;
  /** Round-trip cost of crossing, in basis points. Null if either side is empty. */
  spreadBps: number | null;
}

function level(raw: unknown): BookLevel | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const priceUsd = Number(raw[0]) / PRICE_SCALE;
  const sizeMon = Number(raw[1]) / SIZE_SCALE;
  // Reject-by-default: a level we cannot read is not a level worth showing,
  // and a zero or NaN here would be averaged into a price somewhere else.
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;
  if (!Number.isFinite(sizeMon) || sizeMon <= 0) return null;
  return { priceUsd, sizeMon, notionalUsd: priceUsd * sizeMon };
}

/**
 * Parse a depth response.
 *
 * Bids are returned best-first (highest) and asks best-first (lowest), which
 * is how the endpoint already orders them — but sorted here anyway, because a
 * book displayed in the wrong order is a book that says the spread is
 * negative.
 */
export function parseBook(body: unknown): KuruBook {
  const b = body as { bids?: unknown; asks?: unknown };
  const bids = (Array.isArray(b.bids) ? b.bids : [])
    .map(level)
    .filter((l): l is BookLevel => l !== null)
    .sort((x, y) => y.priceUsd - x.priceUsd);
  const asks = (Array.isArray(b.asks) ? b.asks : [])
    .map(level)
    .filter((l): l is BookLevel => l !== null)
    .sort((x, y) => x.priceUsd - y.priceUsd);

  const bestBidUsd = bids[0]?.priceUsd ?? null;
  const bestAskUsd = asks[0]?.priceUsd ?? null;
  const spreadBps =
    bestBidUsd !== null && bestAskUsd !== null
      ? ((bestAskUsd - bestBidUsd) / ((bestAskUsd + bestBidUsd) / 2)) * 10_000
      : null;

  return { bids, asks, bestBidUsd, bestAskUsd, spreadBps };
}

/**
 * What the book is worth on one side, down to `levels` deep.
 *
 * The number a trader actually wants before sizing an order: not "the price",
 * but how much can be done near it.
 */
export function depthUsd(side: BookLevel[], levels = 10): number {
  return side.slice(0, levels).reduce((sum, l) => sum + l.notionalUsd, 0);
}
