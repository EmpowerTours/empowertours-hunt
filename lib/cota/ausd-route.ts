// ---------------------------------------------------------------------------
// MON -> AUSD: pick between the Uniswap v4 pool and our desk, and run it.
//
// The one place /cota/swap and the one-click run decide this, so the two can
// never disagree about which route a hunter's MON took.
//
// The rule is the hunter's: whichever pays more AUSD for the same MON. Ties go
// to v4, because a desk fill spends AUSD we have to replace by hand. The desk
// is only a candidate while its float covers the quote.
//
// Its per-address cap cannot be read ahead — there is no getter we use — but
// it surfaces in the desk's simulation, before anything is sent. So a desk
// attempt that fails WITHOUT sending falls back to v4 (when v4 had a quote);
// one that failed after sending is reported, never retried.
// ---------------------------------------------------------------------------

import type { Hex, LocalAccount } from "viem";
import {
  SWAP_ABI,
  SWAP_ADDRESS,
  publicClient,
  swapMonToAusdViaDesk,
} from "./swap";
import { quoteMonToAusdV4, swapMonToAusdViaV4 } from "./uniswap-v4";

export type AusdRoute = "v4" | "desk";

export interface RouteQuotes {
  v4: bigint | null;
  desk: bigint | null;
  /** AUSD the desk can still pay out. */
  deskAvailable: bigint | null;
}

/** The better route for these quotes, or null when neither can fill. */
export function chooseRoute(
  q: RouteQuotes,
): { route: AusdRoute; ausdOut: bigint } | null {
  const v4 = q.v4 !== null && q.v4 > 0n ? q.v4 : null;
  const deskFits =
    q.desk !== null &&
    q.desk > 0n &&
    (q.deskAvailable === null || q.desk <= q.deskAvailable);
  const desk = deskFits ? q.desk : null;
  if (v4 === null && desk === null) return null;
  if (desk === null || (v4 !== null && v4 >= desk)) {
    return { route: "v4", ausdOut: v4 as bigint };
  }
  return { route: "desk", ausdOut: desk };
}

/** Both quotes, each null if its read failed. Read-only. */
export async function quoteAusdRoutes(monWei: bigint): Promise<RouteQuotes> {
  const pc = publicClient();
  const [v4, desk, deskAvailable] = await Promise.all([
    quoteMonToAusdV4(monWei).catch(() => null),
    (
      pc.readContract({
        address: SWAP_ADDRESS,
        abi: SWAP_ABI,
        functionName: "quote",
        args: [monWei],
      }) as Promise<bigint>
    ).catch(() => null),
    (
      pc.readContract({
        address: SWAP_ADDRESS,
        abi: SWAP_ABI,
        functionName: "available",
      }) as Promise<bigint>
    ).catch(() => null),
  ]);
  return { v4, desk, deskAvailable };
}

export interface AusdSwapResult {
  route: AusdRoute;
  hash: Hex;
  ausdOut: bigint;
}

/** Injected so the choose-and-fall-back sequencing is testable without a chain. */
export interface AusdRunners {
  quote: (monWei: bigint) => Promise<RouteQuotes>;
  v4: (onSent: (h: Hex) => void) => Promise<{ hash: Hex; ausdOut: bigint }>;
  desk: (onSent: (h: Hex) => void) => Promise<{ hash: Hex; ausdOut: bigint }>;
}

export async function runAusdSwap(
  monWei: bigint,
  r: AusdRunners,
  onSent?: (route: AusdRoute, h: Hex) => void,
): Promise<AusdSwapResult> {
  const choice = chooseRoute(await r.quote(monWei));
  if (choice === null) {
    throw new Error(
      "Neither the Uniswap pool nor the desk can fill this right now.",
    );
  }
  const attempt = async (route: AusdRoute) => {
    let sent = false;
    try {
      const out = await r[route]((h) => {
        sent = true;
        onSent?.(route, h);
      });
      return { route, ...out };
    } catch (e) {
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), {
        sent,
      });
    }
  };
  if (choice.route === "v4") return attempt("v4");
  try {
    return await attempt("desk");
  } catch (e) {
    // Only a desk failure that sent nothing — its cap, a stale price — may
    // fall back. A sent-and-reverted desk swap already cost gas; say so.
    const quotes = await r.quote(monWei);
    if (
      (e as { sent?: boolean }).sent ||
      quotes.v4 === null ||
      quotes.v4 <= 0n
    ) {
      throw e;
    }
    return attempt("v4");
  }
}

/** The real thing: v4 pool or desk, signed by the hunter's wallet. */
export function swapMonToAusd(
  account: LocalAccount,
  monWei: bigint,
  onSent?: (route: AusdRoute, h: Hex) => void,
): Promise<AusdSwapResult> {
  return runAusdSwap(
    monWei,
    {
      quote: quoteAusdRoutes,
      v4: (s) => swapMonToAusdViaV4({ account, monWei, onSent: s }),
      desk: (s) => swapMonToAusdViaDesk(account, monWei, s),
    },
    onSent,
  );
}
