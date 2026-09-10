// The Perpl trading-socket transport — one order per session. Server-only.
//
// A low-level PRIMITIVE: it authenticates and places ONE order, and does NOT
// enforce the leash — the caller (the trade route) loads the key, runs
// enforce.ts against the account state this returns, and only then calls here.
// Kept dumb on purpose: a transport that also decided policy would be two jobs
// in one, and the policy job is the one that must never be bypassable.
//
// Mirrors Mandate's proven client (src/venue_client.py): connect → Ed25519
// sign-in (mt 29) → wallet snapshot (mt 19) → order (mt 22) → status (mt 3) →
// fill (mt 25). Frame build/parse is the conformance-tested layer in ./frames
// and ../order; only the socket choreography lives here.

import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hexToBytes, type Hex } from "viem";
import {
  parseFill,
  parseOrderStatus,
  parseWalletSnapshot,
  signinCanonicalBytes,
  type AccountSnapshot,
  type Fill,
} from "./frames";
import { MT_API_KEY_SIGNIN, orderFrame, type Market } from "../order";

const WS_BASE = process.env.PERPL_WS_URL ?? "wss://app.perpl.xyz";
const TRADING_WS_PATH = "/ws/v1/trading";

export interface PlaceOrderArgs {
  apiKey: string;
  /** Ed25519 signing secret, hex — the enrolled key. */
  secretHex: string;
  market: Market;
  orderType: number;
  sizeUnits: number;
  leverageX: number;
  feeBps: number;
  chainId?: number;
  /** Whole-session cap. */
  timeoutMs?: number;
  /** How long to wait for a fill after an accepted ack before reporting unfilled. */
  fillWaitMs?: number;
}

export interface PlaceOrderResult {
  /** The account the venue reported for this wallet (or null if none). */
  account: AccountSnapshot | null;
  /** The gateway took the order (status code 0). */
  accepted: boolean;
  /** A fill arrived for this order. */
  filled: boolean;
  code: number;
  error: string | null;
  fill: Fill | null;
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Authenticate and place one order. Resolves with the outcome (accepted +
 * filled, accepted-but-unfilled, or rejected); rejects only on transport
 * failure or a total timeout with no answer at all.
 */
export function placeOrder(args: PlaceOrderArgs): Promise<PlaceOrderResult> {
  const chainId = args.chainId ?? 143;
  const timeoutMs = args.timeoutMs ?? 15_000;
  const fillWaitMs = args.fillWaitMs ?? 6_000;
  const url = WS_BASE.replace(/\/$/, "") + TRADING_WS_PATH;

  return new Promise<PlaceOrderResult>((resolve, reject) => {
    const ws = new WebSocket(url);
    const result: PlaceOrderResult = {
      account: null,
      accepted: false,
      filled: false,
      code: -1,
      error: null,
      fill: null,
    };
    let orderSn = -1;
    let orderRq = -1;
    let sent = false;
    let settled = false;
    let fillTimer: ReturnType<typeof setTimeout> | undefined;

    const overall = setTimeout(
      () => finishReject(new Error("perpl trade timed out")),
      timeoutMs,
    );

    function cleanup() {
      clearTimeout(overall);
      if (fillTimer) clearTimeout(fillTimer);
      try {
        ws.close();
      } catch {
        // already closing
      }
    }
    function finish() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }
    function finishReject(e: Error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(e);
    }

    ws.on("open", () => {
      const timestamp = String(Date.now());
      const nonce = b64url(randomBytes(16));
      const canonical = signinCanonicalBytes(chainId, Number(timestamp), nonce);
      const signature = ed25519.sign(
        canonical,
        hexToBytes(args.secretHex as Hex),
      );
      ws.send(
        JSON.stringify({
          mt: MT_API_KEY_SIGNIN,
          chain_id: chainId,
          api_key: args.apiKey,
          timestamp,
          nonce,
          signature: b64url(signature),
        }),
      );
    });

    ws.on("message", (data: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      const mt = msg.mt as number | undefined;

      // Wallet snapshot: learn the account, then place exactly one order.
      if (mt === 19 && !sent) {
        result.account = parseWalletSnapshot(msg)[0] ?? null;
        if (!result.account) {
          result.error = "the venue reports no account on this wallet";
          return finish();
        }
        orderSn = 1;
        orderRq = 1;
        sent = true;
        ws.send(
          JSON.stringify(
            orderFrame({
              sn: orderSn,
              rq: orderRq,
              market: args.market,
              accountId: result.account.accountId,
              orderType: args.orderType,
              sizeUnits: args.sizeUnits,
              leverageX: args.leverageX,
              feeBps: args.feeBps,
            }),
          ),
        );
        return;
      }

      // Status ack for our order.
      if (mt === 3) {
        const st = parseOrderStatus(msg);
        if (st && st.clientSeq === orderSn) {
          result.code = st.code;
          result.accepted = st.accepted;
          result.error = st.error || null;
          if (!st.accepted) return finish(); // rejected — no fill will come
          // Accepted: wait a bounded time for the fill; unfilled is legitimate.
          fillTimer = setTimeout(finish, fillWaitMs);
        }
        return;
      }

      // Fill for our order.
      if (mt === 25 || msg.oid !== undefined) {
        const fill = parseFill(msg);
        if (fill && fill.orderRq === orderRq) {
          result.fill = fill;
          result.filled = fill.sizeScaled > 0;
          return finish();
        }
      }
    });

    ws.on("error", (e: Error) => finishReject(e));
    ws.on("close", () => {
      // Closed after an accepted ack but before a fill: report what we have.
      if (result.accepted) return finish();
      finishReject(
        new Error("perpl socket closed before acknowledging the order"),
      );
    });
  });
}
