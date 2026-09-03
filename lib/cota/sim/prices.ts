// ---------------------------------------------------------------------------
// Real prices for a paper account.
//
// Simulated execution is only worth doing against prices that actually moved.
// A random walk teaches a player nothing about the market they are about to
// put money into, and it cannot surprise them, which is the entire educational
// content of a losing trade.
//
// ## Read-only, and structurally so
//
// This module talks to Perpl's PUBLIC context endpoint and nothing else. There
// is no key, no signer, and no import that could reach the trading API — which
// is why paper mode cannot become live mode by accident. The safety property
// is a missing dependency, not a boolean somebody could flip.
// ---------------------------------------------------------------------------

import { USD_SCALE } from "../scale";

/** Perpl's public config and market state. No authentication. */
const CONTEXT_URL =
  process.env.PERPL_CONTEXT_URL ?? "https://app.perpl.xyz/api/v1/pub/context";

/** A market's mid price, already scaled to the e6 the ceilings are signed in. */
export interface MarkPrice {
  market: string;
  midUsdE6: bigint;
}

/**
 * Perpl publishes prices as an integer plus a per-market decimal count, so BTC
 * arrives as `772201` with `price_decimals: 1` and means 77220.1. Converting
 * through a float here would reintroduce exactly the rounding that
 * lib/cota/scale.ts exists to keep out of numbers that get compared against a
 * ceiling, so the rescale is done in integers.
 */
export function toUsdE6(raw: number | string, priceDecimals: number): bigint {
  const value = BigInt(String(raw).trim());
  if (priceDecimals < 0) {
    throw new RangeError(`negative price_decimals: ${priceDecimals}`);
  }

  const venueScale = 10n ** BigInt(priceDecimals);
  // Multiply before dividing. The other order truncates every price below the
  // venue's own precision to zero.
  return (value * USD_SCALE) / venueScale;
}

interface RawMarket {
  name?: unknown;
  config?: { price_decimals?: unknown } | null;
  state?: { mid?: unknown } | null;
}

/**
 * Pull the mid price out of a context payload.
 *
 * Kept separate from the fetch so it can be tested against a recorded payload
 * without a network call — the parsing is where the bugs live, and a test that
 * needs the internet is a test that gets skipped.
 *
 * Markets missing a name, a mid or a decimal count are dropped rather than
 * defaulted. A market priced at zero because a field was absent would look
 * like a free entry to the engine below.
 */
export function parseMarks(payload: unknown): MarkPrice[] {
  if (typeof payload !== "object" || payload === null) return [];
  const markets = (payload as { markets?: unknown }).markets;
  if (!Array.isArray(markets)) return [];

  const out: MarkPrice[] = [];
  for (const entry of markets as RawMarket[]) {
    const name = entry?.name;
    const mid = entry?.state?.mid;
    const decimals = entry?.config?.price_decimals;

    if (typeof name !== "string" || name.length === 0) continue;
    if (typeof mid !== "number" && typeof mid !== "string") continue;
    if (typeof decimals !== "number") continue;

    try {
      const midUsdE6 = toUsdE6(mid, decimals);
      if (midUsdE6 <= 0n) continue;
      out.push({ market: name, midUsdE6 });
    } catch {
      // A single malformed market must not blank the whole board.
      continue;
    }
  }
  return out;
}

/** Fetch current marks. Throws rather than returning stale or invented prices. */
export async function fetchMarks(signal?: AbortSignal): Promise<MarkPrice[]> {
  const res = await fetch(CONTEXT_URL, { signal, cache: "no-store" });
  if (!res.ok) {
    throw new Error(`perpl context ${res.status}`);
  }
  const marks = parseMarks(await res.json());
  if (marks.length === 0) {
    // Better to fail than to mark a book against an empty price list, which
    // would read as every position being worth nothing.
    throw new Error("perpl context returned no usable markets");
  }
  return marks;
}
