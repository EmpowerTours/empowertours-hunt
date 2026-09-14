import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requirePlayer } from "@/lib/auth";
import { prisma } from "@/lib/db/prisma";
import { loadPerpKey } from "@/lib/cota/keystore";
import { MON_MARKET, planOpen, type Market } from "@/lib/cota/order";
import { placeOrder } from "@/lib/cota/venue/client";
import { readMark } from "@/lib/cota/venue/market-data";
import type { AccountSnapshot } from "@/lib/cota/venue/frames";
import { type MarkedMarket } from "@/lib/cota/venue/account-state";
import { readDayState } from "@/lib/cota/day-state";
import type { Unexplained } from "@/lib/cota/venue/adopt";
import {
  recordFill,
  recordPlacedOrder,
  fillToLedgerFill,
  directionOfOrderType,
  newAgentOrderId,
} from "@/lib/cota/ledger";
import { boundFromRow } from "@/lib/cota/bound";
import { explainDenial } from "@/lib/cota/enforce";

// ---------------------------------------------------------------------------
// POST /api/cota/trade — place one bounded order for the signed-in hunter.
//
// Flow: load the active Cota → load the server-held trading key → read the mark
// → READ THE LIVE DAY-STATE (open notional from the venue snapshot, loss from
// the fills ledger) → plan+GATE the order (enforce.ts) → and ONLY if the leash
// allows it, place it on the venue, then record the fill. The gate runs before
// the transport; there is no path that reaches placeOrder without passing mayOpen.
//
// Before the gate runs at all there is a VENUE preflight: an account with
// forwarding disabled (`fw:false`) cannot execute any order, so the route says
// so rather than sending one that the gateway accepts and the chain drops.
//
// The aggregate bounds (open-notional ceiling, daily-loss stop) ARE enforced:
// buildAggregateState reads real positions + the fill ledger, and if loss can't
// be vouched for (the venue holds size we have no fills for) toDayState returns
// null and this route REFUSES — it never trades on a loss it can't verify, and
// never substitutes a zeroed day-state. See lib/cota/venue/aggregate.ts.
// ---------------------------------------------------------------------------

const BUILDER_FEE_BPS = 2; // matches the proven builder-9 fill

// Only MON is pinned so far. Other markets need their own pin (id + decimals);
// until then they are refused rather than traded on a guessed scale.
const MARKETS: Record<string, Market> = { MON: MON_MARKET };

const Input = z.object({
  digest: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .optional(),
  market: z.string().min(1).max(32),
  side: z.enum(["long", "short"]),
  targetNotionalUsd: z.number().positive().finite(),
  leverageX: z.number().positive().finite(),
});

export async function POST(req: Request) {
  try {
    const player = await requirePlayer(req);
    const parsed = Input.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "bad request" }, { status: 400 });
    }
    const { digest, side, targetNotionalUsd, leverageX } = parsed.data;
    const symbol = parsed.data.market.toUpperCase();

    const market = MARKETS[symbol];
    if (!market) {
      return NextResponse.json(
        { error: `market ${symbol} is not supported yet` },
        { status: 400 },
      );
    }

    const cota = digest
      ? await prisma.cota.findFirst({
          where: { digest, playerId: player.id, revokedAt: null },
        })
      : await prisma.cota.findFirst({
          where: {
            playerId: player.id,
            revokedAt: null,
            markets: { isEmpty: false },
          },
          orderBy: { createdAt: "desc" },
        });
    if (!cota) {
      return NextResponse.json(
        { error: "no active leash — sign a Cota first" },
        { status: 409 },
      );
    }

    const cred = await loadPerpKey(player.id);
    if (!cred) {
      return NextResponse.json(
        { error: "no trading key — authorize one first" },
        { status: 409 },
      );
    }

    const markUsd = await readMark(market.id, market.priceDecimals);

    // Read the LIVE day-state: open notional from the venue's own position
    // snapshot, loss from our fill ledger. If this read fails, we cannot verify
    // the aggregate bounds, so we refuse rather than trade blind.
    //
    // readDayState may repair one thing on its own: a fill this agent's own
    // accepted order produced that the placing socket closed before seeing. That
    // is bookkeeping on an order the leash already gated. Anything else it holds
    // back as `unexplained`, and the refusal below routes the hunter to an
    // explicit reconcile rather than adopting a trade the agent never made.
    let dayState;
    let venueAccount: AccountSnapshot | null = null;
    let unexplained: Unexplained[] = [];
    try {
      const marks = new Map<number, MarkedMarket>([
        [market.id, { market, markUsd }],
      ]);
      const read = await readDayState({
        playerId: player.id,
        account: cred.account,
        apiKey: cred.apiKey,
        secretHex: cred.secretHex,
        marks,
        nowMs: Date.now(),
      });
      dayState = read.dayState;
      venueAccount = read.venueAccount;
      unexplained = read.unexplained;
    } catch (e) {
      console.error("[cota/trade] day-state read failed", e);
      return NextResponse.json({
        allowed: false,
        reason: "state_unavailable",
        detail:
          "could not read the account's live positions to verify the open-notional and daily-loss limits; refusing",
        markUsd,
      });
    }

    // Forwarding preflight. `fw` on the account frame is whether the venue will
    // forward an order to the chain on this account's behalf; with it off the
    // gateway returns code 0 and the chain silently refuses, which reads to a
    // hunter as "Accepted (not filled yet)" forever. A fresh Perpl account
    // defaults to fw:false, so this is the FIRST thing a new hunter hits — name
    // it instead of sending an order that cannot fill.
    //
    // A null account is not treated as a refusal: the venue named no account, a
    // condition placeOrder already reports on its own, and guessing here would
    // block a hunter on a frame we failed to read rather than on a real flag.
    if (venueAccount && !venueAccount.forwardingAllowed) {
      return NextResponse.json({
        allowed: false,
        reason: "forwarding_disabled",
        detail:
          "this Perpl account has order forwarding disabled (fw:false), so the venue accepts orders it will never execute; nothing was sent",
        accountId: venueAccount.accountId,
        markUsd,
      });
    }

    // Null means loss could not be vouched for (the venue holds size we have no
    // fills for). Fail closed — never trade on a loss we can't verify.
    if (dayState === null) {
      return NextResponse.json({
        allowed: false,
        reason: "loss_unverifiable",
        detail:
          "the account holds positions this agent has no fill history for, so the daily-loss limit cannot be verified; refusing until reconciled",
        // What the hunter can act on: each entry is size the venue holds that
        // nothing in the ledger accounts for. `reconcilable` says whether
        // adopting it is even possible — a position the venue prices can be
        // adopted at that price, one it doesn't cannot be adopted at all.
        unexplained,
        reconcilable:
          unexplained.length > 0 &&
          unexplained.every((u) => u.reason === "no_pending_order"),
        markUsd,
      });
    }

    const plan = planOpen({
      bound: boundFromRow(cota),
      state: dayState,
      market,
      side,
      targetNotionalUsd,
      markPriceUsd: markUsd,
      leverageX,
      nowSeconds: BigInt(Math.floor(Date.now() / 1000)),
    });

    // The gate is the chokepoint: a rejected plan never reaches the venue.
    if (!plan.decision.ok) {
      return NextResponse.json({
        allowed: false,
        reason: plan.decision.reason,
        detail: explainDenial(plan.decision.reason),
        markUsd,
      });
    }
    if (plan.sizeUnits <= 0) {
      return NextResponse.json({
        allowed: false,
        reason: "size_zero",
        detail: "target is too small for one unit at the current price",
        markUsd,
      });
    }

    // One id for this order, minted here and used on BOTH the fill row and the
    // pending-order row, so an order that is adopted later counts as the same
    // single order it always was. See newAgentOrderId for why the venue's own rq
    // cannot serve.
    const agentOrderId = newAgentOrderId();

    const result = await placeOrder({
      apiKey: cred.apiKey,
      secretHex: cred.secretHex,
      market,
      orderType: plan.orderType,
      sizeUnits: plan.sizeUnits,
      leverageX,
      feeBps: BUILDER_FEE_BPS,
    });

    // Record the fill so the NEXT trade's loss read reconciles. A failure here
    // is self-protecting: a missing row means the next reconcile mismatches and
    // the route fails closed, rather than under-reporting loss.
    if (result.filled && result.fill) {
      try {
        await recordFill(
          player.id,
          cred.account,
          fillToLedgerFill(
            result.fill,
            market,
            plan.orderType,
            Date.now(),
            agentOrderId,
          ),
        );
      } catch (e) {
        console.error("[cota/trade] fill record failed", e);
      }
    } else if (result.accepted) {
      // Accepted, not filled — the chain fills after the gateway acks and this
      // socket is already closing. Without this row the fill that lands in a
      // moment is invisible to the ledger forever, and every later order refuses
      // (account 5273, 2026-09-14: 214 MON open, ledger empty). With it, the
      // next read adopts the fill at the venue's own entry price.
      try {
        await recordPlacedOrder(player.id, cred.account, {
          marketId: market.id,
          direction: directionOfOrderType(plan.orderType),
          sizeUnits: plan.sizeUnits,
          orderId: agentOrderId,
        });
      } catch (e) {
        console.error("[cota/trade] pending order record failed", e);
      }
    }

    return NextResponse.json({
      allowed: true,
      accepted: result.accepted,
      filled: result.filled,
      code: result.code,
      error: result.error,
      fill: result.fill,
      sizeUnits: plan.sizeUnits,
      notionalUsd: plan.notionalUsd,
      markUsd,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    console.error("[cota/trade] failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}
