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
