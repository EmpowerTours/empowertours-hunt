// Read-only venue gather: connect, sign in, collect the account's OPEN positions
// (mt 26 snapshot / 27 update), close. It NEVER sends an order — it's the
// authoritative size half of the aggregate read, paired with the fills ledger
// for loss. Mirrors the sign-in choreography of client.ts (the tested transport).

import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hexToBytes, type Hex } from "viem";
import {
  parsePositions,
  signinCanonicalBytes,
  type OpenPositionFrame,
} from "./frames";
import { MT_API_KEY_SIGNIN } from "../order";

const WS_BASE = process.env.PERPL_WS_URL ?? "wss://app.perpl.xyz";
const TRADING_WS_PATH = "/ws/v1/trading";

export interface ReadPositionsArgs {
  apiKey: string;
  secretHex: string;
  chainId?: number;
  timeoutMs?: number;
  /** How long to gather position frames after sign-in before returning. */
  settleMs?: number;
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Gather the account's open positions. Resolves with one frame per still-open
 * pid after a short settle window; rejects only on transport failure or a total
 * timeout. A position that arrives then closes within the window is dropped, so
 * the result reflects what is open at the end of the read.
 */
export function readAccountPositions(
  args: ReadPositionsArgs,
): Promise<OpenPositionFrame[]> {
  const chainId = args.chainId ?? 143;
  const timeoutMs = args.timeoutMs ?? 12_000;
  const settleMs = args.settleMs ?? 3_000;
  const url = WS_BASE.replace(/\/$/, "") + TRADING_WS_PATH;

  return new Promise<OpenPositionFrame[]>((resolve, reject) => {
    const ws = new WebSocket(url);
    const byPid = new Map<number, OpenPositionFrame>();
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const overall = setTimeout(
      () => finishReject(new Error("perpl positions read timed out")),
      timeoutMs,
    );

    function cleanup() {
      clearTimeout(overall);
      if (settleTimer) clearTimeout(settleTimer);
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
      resolve([...byPid.values()]);
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

      // The wallet snapshot (19) arrives right after sign-in; start the settle
      // window then, so positions have a bounded moment to stream in.
      if (mt === 19 && settleTimer === undefined) {
        settleTimer = setTimeout(finish, settleMs);
      }

      if (mt === 26 || mt === 27) {
        const d = (msg as { d?: unknown[] }).d;
        if (!Array.isArray(d)) return;
        const opens = parsePositions(msg);
        const openPids = new Set(opens.map((p) => p.pid));
        // A frame carrying a pid that is NOT open is a close/liquidation — drop it.
        for (const raw of d) {
          const pid = (raw as { pid?: unknown }).pid;
          if (typeof pid === "number" && !openPids.has(pid)) byPid.delete(pid);
        }
        for (const p of opens) byPid.set(p.pid, p);
      }
    });

    ws.on("error", (e: Error) => finishReject(e));
    ws.on("close", () => {
      if (settleTimer !== undefined) finish();
      else finishReject(new Error("perpl socket closed before sign-in"));
    });
  });
}
