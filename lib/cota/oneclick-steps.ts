// ---------------------------------------------------------------------------
// The four steps, as functions one press can run.
//
// Each wraps work that already existed and was reachable only from its own
// screen: swapMonToAusdViaKuru from /cota/swap, fundPerpl from /cota/deposit,
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
import { swapMonToAusdViaKuru } from "./kuru-swap";
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
      const r = await swapMonToAusdViaKuru({
        account,
        monWei: plan.swapMonWei,
      });
      carry.wentThroughOrderBook = r.wentThroughOrderBook;

      // Record the book trade so it reaches the MON-moved leaderboard. A
      // failure to RECORD must not fail the swap: the money already moved, and
      // throwing here would tell the hunter their swap failed when it did not.
      try {
        await fetch("/api/cota/kuru/history", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hash: r.bookTxHash, side: "sell" }),
        });
      } catch {
        // Recoverable later from the hash, which is on chain either way.
      }
      return r.bookTxHash;
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
        reason?: string;
        error?: string;
      };
      // allowed === false is the LEASH refusing, which is the product working,
      // not an outage. It still stops the run, and it still has to say so in
      // the hunter's words rather than as a silent no-op.
      if (!res.ok || body.allowed === false || body.accepted === false) {
        throw new Error(body.reason ?? body.error ?? "the order was refused");
      }
      return "placed";
    },
  };
}
