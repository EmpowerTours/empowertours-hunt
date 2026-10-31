// ---------------------------------------------------------------------------
// The four steps, as functions one press can run.
//
// Each wraps work that already existed and was reachable only from its own
// screen: swapMonToAusd from /cota/swap, fundPerpl from /cota/deposit,
// signAndAnchorCota from /cota, and the trade POST from /cota/trade. Nothing
// here reimplements any of them — a second implementation of a money path is
// how two screens end up disagreeing about what a hunter owns.
//
// ONE PASSKEY UNLOCK COVERS ALL FOUR. The account is a viem LocalAccount
// derived from the passkey PRF, so it signs every transaction without prompting
// again. That is the whole reason one press can be one press.
//
// The digest has to travel from the leash step to the trade step, which is why
// this is a factory over a shared `carry` object rather than four free
// functions: the trade cannot name the leash that authorises it until the leash
// exists, and a hunter who already had a live leash passes its digest in.
// ---------------------------------------------------------------------------

import type { LocalAccount } from "viem";
import { swapMonToAusd } from "./ausd-route";
import { fundPerpl } from "./deposit";
import { signAndAnchorCota } from "./sign";
import { newBrowserNonce } from "./sign";
import { cotaDigest, type CotaMessage } from "./typedData";
import type { Plan, Step } from "./oneclick";
import type { Runners } from "./oneclick-run";

/** The leash a one-click press signs when the hunter has none. */
export interface Ceilings {
  venue: CotaMessage["venue"];
  markets: readonly string[];
  maxNotionalUsdE6: bigint;
  maxLeverageX100: bigint;
  maxDailyLossUsdE6: bigint;
  maxTradesPerDay: number;
  durationSeconds: bigint;
}

export interface Carry {
  /** The leash that will authorise the trade. Set by the leash step. */
  digest: string | null;
  /** True when leg 1 of the swap really crossed Kuru's book. */
  wentThroughOrderBook: boolean | null;
}

export function buildRunners(args: {
  account: LocalAccount;
  plan: Plan;
  ceilings: Ceilings;
  market: string;
  side: "long" | "short";
  notionalUsd: number;
  leverageX: number;
  carry: Carry;
  onStep?: (step: Step, detail?: string) => void;
}): Runners {
  const { account, plan, ceilings, carry } = args;
  const note = args.onStep ?? (() => {});

  return {
    swap: async () => {
      note("swap");
      // The Uniswap v4 pool or our desk, whichever pays more — the same choice
      // /cota/swap makes (ausd-route.ts). Either is one atomic transaction: it
      // pays at least its floor or reverts, so a failure never strands USDC.
      const r = await swapMonToAusd(account, plan.swapMonWei);
      carry.wentThroughOrderBook = false;
      return r.hash;
    },

    deposit: async () => {
      note("deposit");
      const r = await fundPerpl(account, plan.depositAusd6);
      return r.txHash;
    },

    leash: async () => {
      note("leash");
      // Clock and nonce read HERE, not earlier: clientTs has to be inside the
      // skew window at the moment of signing, and a swap that took two minutes
      // would otherwise push a message prepared up front outside it.
      const now = BigInt(Math.floor(Date.now() / 1000));
      const message: CotaMessage = {
        venue: ceilings.venue,
        markets: ceilings.markets,
        maxNotionalUsdE6: ceilings.maxNotionalUsdE6,
        maxLeverageX100: ceilings.maxLeverageX100,
        maxDailyLossUsdE6: ceilings.maxDailyLossUsdE6,
        maxTradesPerDay: ceilings.maxTradesPerDay,
        notBefore: now,
        notAfter: now + ceilings.durationSeconds,
        clientTs: now,
        nonce: newBrowserNonce(),
      };
      const signed = await signAndAnchorCota(message);
      const res = await fetch("/api/cota", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          venue: message.venue,
          markets: message.markets,
          maxNotionalUsdE6: message.maxNotionalUsdE6.toString(),
          maxLeverageX100: message.maxLeverageX100.toString(),
          maxDailyLossUsdE6: message.maxDailyLossUsdE6.toString(),
          maxTradesPerDay: message.maxTradesPerDay,
          notBefore: message.notBefore.toString(),
          notAfter: message.notAfter.toString(),
          clientTs: message.clientTs.toString(),
          nonce: message.nonce,
          signature: signed.signature,
          ...(signed.anchorTxHash ? { anchorTxHash: signed.anchorTxHash } : {}),
        }),
      });
      const body = (await res.json()) as {
        cota?: { digest: string };
        error?: string;
      };
      if (!res.ok || !body.cota?.digest) {
        throw new Error(body.error ?? "the leash was not accepted");
      }
      // The server's digest, not the one computed here. They should agree, and
      // if they ever do not it is the server's that the enforcer will check an
      // order against, so trading under ours would be trading under a leash
      // nothing enforces.
      carry.digest = body.cota.digest;
      void cotaDigest;
      return signed.anchorTxHash ?? body.cota.digest;
    },

    trade: async () => {
      note("trade");
      if (!carry.digest) {
        throw new Error("no leash to trade under");
      }
      const res = await fetch("/api/cota/trade", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          digest: carry.digest,
          market: args.market,
          side: args.side,
          targetNotionalUsd: args.notionalUsd,
          leverageX: args.leverageX,
        }),
      });
      const body = (await res.json()) as {
        allowed?: boolean;
        accepted?: boolean;
        filled?: boolean;
        reason?: string;
        error?: string;
        venue?: {
          statusName?: string;
          reasonName?: string;
          terminal?: boolean;
          expectsFill?: boolean;
        } | null;
      };
      // allowed === false is the LEASH refusing, which is the product working,
      // not an outage. It still stops the run, and it still has to say so in
      // the hunter's words rather than as a silent no-op.
      if (!res.ok || body.allowed === false || body.accepted === false) {
        throw new Error(body.reason ?? body.error ?? "the order was refused");
      }
      return tradeOutcome(body);
    },
  };
}

/**
 * Did the order actually open a position? Accepted is NOT enough.
 *
 * The gateway accepting an order only means it was taken. On 2026-10-31 a
 * one-click run reported "your trade is open" for an order Perpl had already
 * terminally refused (status Failed, reason TakerOrderSettlementFailed, 0 of
 * 1,344 filled) — the step returned "placed" on `accepted` alone, and the
 * hunter went looking for a position that did not exist.
 *
 * Done only when the venue filled it or said size changed hands. A refusal
 * names the venue's reason. An order neither filled nor refused yet is not
 * claimed as open either: the run stops and says it is still pending.
 */
export function tradeOutcome(body: {
  filled?: boolean;
  venue?: {
    statusName?: string;
    reasonName?: string;
    terminal?: boolean;
    expectsFill?: boolean;
  } | null;
}): string {
  const v = body.venue ?? null;
  if (body.filled === true || v?.expectsFill === true) return "filled";
  if (v?.terminal) {
    throw new Error(
      `Perpl refused the order (${v.statusName ?? "failed"}: ${v.reasonName ?? "no reason given"}). No position was opened.`,
    );
  }
  throw new Error(
    "Perpl accepted the order but has not filled it yet, so no position is open. Check Results in a minute.",
  );
}
