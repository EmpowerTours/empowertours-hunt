// Perpl's public market-data socket — read one mark price, then close.
// Server-only. Unauthenticated + read-only (no keys, sends no orders).
//
// Ported from Mandate's MarketDataClient (src/market_data.py): one batched
// subscribe to the chain-wide `market-state@<chain>` stream, then market-state
// frames (mt 9) carry every market under `d[<id>]` with `mrk` scaled by that
// market's price_decimals. The trade route needs the mark to size a $ target
// into units and to check the leash's notional cap; Kimi uses it as context.

import WebSocket from "ws";

const WS_BASE = process.env.PERPL_WS_URL ?? "wss://app.perpl.xyz";
const MARKET_DATA_WS_PATH = "/ws/v1/market-data";
const MT_SUBSCRIBE = 5;
const MT_SUBSCRIBE_RESPONSE = 6;
const MT_MARKET_STATE = 9;
const CHAIN_ID = 143;

/**
 * Extract a market's mark (USD) from a market-state frame, or null if this
 * frame doesn't carry it. Pure, so the parse is testable without a socket.
 */
/**
 * Bid and ask from the same mt 9 frame, for pricing an EXIT where it will fill.
 *
 * A close crosses the book: a long sells into the bid, a short buys the ask.
 * Valuing it at the mark overstates every close by half the spread, and on MON
 * that half-spread (12 bps) is larger than both fees combined — enough to turn a
 * position the agent believes is profitable into a realised loss. exit.ts takes
 * a fill price for exactly this reason, and this is where that price comes from.
 *
 * Either side may be absent on a market with an empty book; null then, and the
 * caller must refuse to act rather than substitute the mark.
 */
export function bookFromFrame(
  msg: unknown,
  marketId: number,
  priceDecimals: number,
): { bidUsd: number | null; askUsd: number | null } | null {
  const f = msg as {
    mt?: number;
    d?: Record<string, { bid?: number; ask?: number } | null>;
  };
  if (f?.mt !== 9 || !f.d) return null;
  const state = f.d[String(marketId)];
  if (!state) return null;
  const scale = 10 ** priceDecimals;
  const num = (v: number | undefined) =>
    v === undefined || !Number.isFinite(Number(v)) || Number(v) <= 0
      ? null
      : Number(v) / scale;
  return { bidUsd: num(state.bid), askUsd: num(state.ask) };
}

/** The price a close would FILL at: the bid for a long, the ask for a short. */
export function exitPriceFor(
  signedSize: number,
  book: { bidUsd: number | null; askUsd: number | null },
): number | null {
  if (signedSize > 0) return book.bidUsd;
  if (signedSize < 0) return book.askUsd;
  return null;
}

export function markFromFrame(
  msg: unknown,
  marketId: number,
  priceDecimals: number,
): number | null {
  const f = msg as { mt?: number; d?: Record<string, { mrk?: number } | null> };
  if (f?.mt !== MT_MARKET_STATE || !f.d) return null;
  const state = f.d[String(marketId)];
  if (!state || state.mrk === undefined) return null;
  const mrk = Number(state.mrk);
  if (!Number.isFinite(mrk) || mrk <= 0) return null;
  return mrk / 10 ** priceDecimals;
}

/** True if a subscribe-response frame reports any rejected subscription. */
function subscribeRejected(msg: unknown): boolean {
  const f = msg as {
    mt?: number;
    subs?: { status?: { code?: number } }[];
  };
  if (f?.mt !== MT_SUBSCRIBE_RESPONSE || !Array.isArray(f.subs)) return false;
  return f.subs.some((s) => {
    const code = s.status?.code;
    return code !== undefined && code !== 0;
  });
}

/**
 * Connect, subscribe, read one mark for `marketId` (USD), then close. Rejects on
 * timeout, a rejected subscription, or transport failure — never returns a
 * stale or guessed price.
 */
export function readMark(
  marketId: number,
  priceDecimals: number,
  opts: { chainId?: number; timeoutMs?: number } = {},
): Promise<number> {
  const chainId = opts.chainId ?? CHAIN_ID;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const url = WS_BASE.replace(/\/$/, "") + MARKET_DATA_WS_PATH;

  return new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    const timer = setTimeout(
      () =>
        finishReject(
          new Error(
            `market-data: no mark for market ${marketId} in ${timeoutMs}ms`,
          ),
        ),
      timeoutMs,
    );

    function cleanup() {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // already closing
      }
    }
    function finish(v: number) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(v);
    }
    function finishReject(e: Error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(e);
    }

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          mt: MT_SUBSCRIBE,
          subs: [
            { stream: `heartbeat@${chainId}`, subscribe: true },
            { stream: `market-state@${chainId}`, subscribe: true },
          ],
        }),
      );
    });

    ws.on("message", (data: Buffer) => {
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (subscribeRejected(msg)) {
        return finishReject(new Error("market-data: subscription rejected"));
      }
      const mark = markFromFrame(msg, marketId, priceDecimals);
      if (mark !== null) finish(mark);
    });

    ws.on("error", (e: Error) => finishReject(e));
    ws.on("close", () =>
      finishReject(
        new Error("market-data socket closed before a mark arrived"),
      ),
    );
  });
}

/**
 * Bid and ask for one market, from Perpl's public context endpoint.
 *
 * REST rather than the market-data socket, deliberately: the socket's mt 9
 * carries the mark and this needs the two sides of the book, and the context
 * endpoint already publishes both with no connection to hold open. One GET, the
 * venue's own numbers.
 *
 * Returns null when the market is absent or either side is missing. A caller
 * pricing an exit must refuse on null rather than fall back to the mark — the
 * mark is precisely the number that makes a losing close look profitable.
 */
export async function readBook(
  marketId: number,
  priceDecimals: number,
  opts: { signal?: AbortSignal } = {},
): Promise<{ bidUsd: number | null; askUsd: number | null } | null> {
  const url =
    process.env.PERPL_CONTEXT_URL ?? "https://app.perpl.xyz/api/v1/pub/context";
  const res = await fetch(url, { signal: opts.signal, cache: "no-store" });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    markets?: { id?: number; state?: { bid?: number; ask?: number } }[];
  };
  const m = body.markets?.find((x) => x.id === marketId);
  if (!m?.state) return null;
  const scale = 10 ** priceDecimals;
  const num = (v: number | undefined) =>
    v === undefined || !Number.isFinite(Number(v)) || Number(v) <= 0
      ? null
      : Number(v) / scale;
  return { bidUsd: num(m.state.bid), askUsd: num(m.state.ask) };
}
