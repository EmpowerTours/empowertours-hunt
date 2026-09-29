// ---------------------------------------------------------------------------
// Recent price history, so the proposer has something to reason about.
//
// WHY THIS EXISTS. The Kimi proposer was being handed the leash's limits and a
// single spot price, then asked to propose a trade — and told to "prefer
// holding over a marginal trade". A competent model in that position holds
// every time, and it is right to: one number is not a market. Every proposal
// came back "hold", which read as the integration being decorative when it was
// actually the only honest answer available to it.
//
// This does not make the model bullish. It gives it a series, so that whichever
// way it decides, the decision is about the market rather than about the
// absence of one.
//
// EXECUTION STILL PRICES OFF PERPL. This is context, never the mark: the order
// is sized and filled against Perpl's own book, and nothing here is allowed to
// influence that. A stale or wrong point here can make the model less sure; it
// cannot make anyone trade at a bad price.
//
// COINGECKO, NOT PERPL, because Perpl's context endpoint returns current marks
// only — there is no history to ask it for. Free, keyless, and already the
// source the MON/AUSD desk was priced from before Chainlink took over.
// ---------------------------------------------------------------------------

const API = process.env.COINGECKO_API_URL ?? "https://api.coingecko.com/api/v3";

/** CoinGecko ids for the markets a Cota can name. */
const COIN_IDS: Record<string, string> = {
  MON: "monad",
  BTC: "bitcoin",
  ETH: "ethereum",
};

export interface PriceHistory {
  /** Oldest first. Human units, rounded for the prompt rather than for maths. */
  closes: number[];
  /** Percentage move across the window, or null when it cannot be computed. */
  changePct: number | null;
  high: number;
  low: number;
  hours: number;
}

export function hasHistory(market: string): boolean {
  return COIN_IDS[market.toUpperCase()] !== undefined;
}

/**
 * Reduce a dense series to something a prompt can carry.
 *
 * CoinGecko returns ~289 points for a day. Sending them all wastes context and
 * invites the model to pattern-match on noise; a dozen evenly spaced closes
 * describe the same shape. Always keeps the newest point, because the end of
 * the series is the part a trader actually reasons from.
 */
export function downsample(values: number[], want: number): number[] {
  if (values.length <= want) return values;
  const step = (values.length - 1) / (want - 1);
  const out: number[] = [];
  for (let i = 0; i < want - 1; i += 1) {
    out.push(values[Math.round(i * step)]!);
  }
  out.push(values[values.length - 1]!);
  return out;
}

export function summarise(closes: number[], hours: number): PriceHistory {
  const first = closes[0];
  const last = closes[closes.length - 1];
  return {
    closes,
    changePct:
      first !== undefined && last !== undefined && first > 0
        ? ((last - first) / first) * 100
        : null,
    high: closes.length ? Math.max(...closes) : 0,
    low: closes.length ? Math.min(...closes) : 0,
    hours,
  };
}

export function parseMarketChart(body: unknown): number[] {
  const rows = (body as { prices?: unknown })?.prices;
  if (!Array.isArray(rows)) return [];
  const out: number[] = [];
  for (const row of rows) {
    // [millis, price]. A row we cannot read is dropped rather than zeroed —
    // a zero in a price series is a crash the model would try to explain.
    if (!Array.isArray(row) || row.length < 2) continue;
    const price = row[1];
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
      continue;
    }
    out.push(price);
  }
  return out;
}

/**
 * Recent closes for a market, or null when there is nothing trustworthy.
 *
 * Null rather than an empty series on purpose: the prompt says "no history
 * available" in that case, which is true and leaves the model free to hold for
 * the right reason. An empty array would read as a market that never moved.
 */
export async function fetchPriceHistory(
  market: string,
  deps: { fetch?: typeof fetch; signal?: AbortSignal; hours?: number } = {},
): Promise<PriceHistory | null> {
  const id = COIN_IDS[market.toUpperCase()];
  if (id === undefined) return null;
  const hours = deps.hours ?? 24;
  const doFetch = deps.fetch ?? fetch;
  try {
    const res = await doFetch(
      `${API}/coins/${id}/market_chart?vs_currency=usd&days=${hours / 24}`,
      { signal: deps.signal, cache: "no-store" },
    );
    if (!res.ok) return null;
    const closes = parseMarketChart(await res.json());
    if (closes.length < 2) return null;
    return summarise(downsample(closes, 12), hours);
  } catch {
    // A proposer that fails because a context API is down is worse than one
    // that proposes with less context and says so.
    return null;
  }
}
