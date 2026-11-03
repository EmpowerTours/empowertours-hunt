// ---------------------------------------------------------------------------
// Perpl's MON one-minute candles, for the play game.
//
// Public market data: no key, no account, nothing that can trade. Verified
// 2026-11-02 against https://app.perpl.xyz/api/v1/market-data/10/candles/60/...
// (MON is market 10 on mainnet; prices are scaled 1e6, 17549 = $0.017549).
//
// A SHORT SHARED CACHE. Every player polling the game wants the same few
// minutes of the same market, so the latest window is fetched at most once per
// TTL per instance however many players are on. That is load protection for
// Perpl as much as for us — their market-data API is rate limited per caller.
//
// SERVER ONLY.
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { Candle } from "./advance";

const API = process.env.PERPL_API_URL ?? "https://app.perpl.xyz/api";
const MON_MARKET = 10;
const MINUTE = 60_000;
/** Perpl's own cap per request. */
const MAX_CANDLES = 1_024;
/** How far back a game that was left alone is caught up. Beyond this the
 *  walls simply resume from now: a week-old position is not worth paging a
 *  week of history for, and it is play money. */
export const MAX_CATCHUP_MS = 3 * 24 * 60 * MINUTE;
const RECENT_TTL_MS = 2_000;
const TIMEOUT_MS = 8_000;

const CandleSchema = z.object({
  t: z.number().int(),
  o: z.number().int(),
  h: z.number().int(),
  l: z.number().int(),
  c: z.number().int(),
  n: z.number().int(),
});
const SeriesSchema = z.object({ d: z.array(CandleSchema) });

export class FeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedError";
  }
}

async function fetchRange(fromMs: number, toMs: number): Promise<Candle[]> {
  const url = `${API}/v1/market-data/${MON_MARKET}/candles/60/${fromMs}-${toMs}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) throw new FeedError(`perpl candles ${res.status}`);
    const parsed = SeriesSchema.safeParse(await res.json());
    if (!parsed.success) throw new FeedError("perpl candles: unexpected shape");
    return parsed.data.d;
  } catch (err) {
    if (err instanceof FeedError) throw err;
    throw new FeedError(
      ctrl.signal.aborted
        ? "perpl candles timed out"
        : "perpl candles unreachable",
    );
  } finally {
    clearTimeout(timer);
  }
}

let recent: { at: number; fromMs: number; candles: Candle[] } | null = null;
let inflight: Promise<Candle[]> | null = null;

/** The last ~30 minutes, shared across callers for RECENT_TTL_MS. */
async function recentWindow(
  now: number,
): Promise<{ fromMs: number; candles: Candle[] }> {
  if (recent && now - recent.at < RECENT_TTL_MS) return recent;
  const fromMs = Math.floor((now - 30 * MINUTE) / MINUTE) * MINUTE;
  if (!inflight) {
    inflight = fetchRange(fromMs, now).finally(() => {
      inflight = null;
    });
  }
  const candles = await inflight;
  const fresh = { at: now, fromMs, candles };
  // Two callers can both land here after one fetch; whichever writes last
  // stores an equally fresh window, so the race is harmless by construction.
  // eslint-disable-next-line require-atomic-updates
  recent = fresh;
  return fresh;
}

/**
 * Every candle from `sinceMs` (inclusive, minute-aligned by the caller) to now,
 * sorted and de-duplicated. Uses the shared recent window when it covers the
 * request, and pages history otherwise.
 */
export async function candlesSince(
  sinceMs: number,
  now = Date.now(),
): Promise<Candle[]> {
  const from = Math.max(sinceMs, now - MAX_CATCHUP_MS);
  const win = await recentWindow(now);
  if (from >= win.fromMs) return win.candles.filter((c) => c.t >= from);

  const out = new Map<number, Candle>();
  for (let t = from; t < win.fromMs; t += MAX_CANDLES * MINUTE) {
    for (const c of await fetchRange(
      t,
      Math.min(t + MAX_CANDLES * MINUTE, win.fromMs),
    ))
      out.set(c.t, c);
  }
  for (const c of win.candles) out.set(c.t, c);
  return [...out.values()].filter((c) => c.t >= from).sort((a, b) => a.t - b.t);
}

/** The latest traded price, or null if Perpl returned no candles at all. */
export async function latestPrice(
  now = Date.now(),
): Promise<{ price: number; t: number } | null> {
  const win = await recentWindow(now);
  const last = win.candles[win.candles.length - 1];
  return last ? { price: last.c, t: last.t } : null;
}

/** The last ~30 minutes of traded closes, for drawing the ball's trail. */
export async function recentTrail(now = Date.now()): Promise<Array<{ t: number; p: number }>> {
  const win = await recentWindow(now);
  return win.candles.filter((c) => c.n > 0).map((c) => ({ t: c.t, p: c.c }));
}
