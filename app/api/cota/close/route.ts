import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requirePlayer } from "@/lib/auth";
import { loadPerpKey } from "@/lib/cota/keystore";
import { executableMarket, planClose } from "@/lib/cota/order";
import { placeOrder } from "@/lib/cota/venue/client";
import { readMark } from "@/lib/cota/venue/market-data";
import { readAccountPositions } from "@/lib/cota/venue/account-read";
import {
  entryUsdWithResidue,
  signedSizeFromFrame,
} from "@/lib/cota/venue/aggregate";
import { venueConfirmedFill, venueRefusedOrder } from "@/lib/cota/venue/frames";
import type { MarkedMarket } from "@/lib/cota/venue/account-state";
import {
  recordFill,
  recordPlacedOrder,
  fillToLedgerFill,
  directionOfOrderType,
  newAgentOrderId,
} from "@/lib/cota/ledger";

// ---------------------------------------------------------------------------
// POST /api/cota/close — reduce or close the hunter's open position.
//
// The half of the leash that existed only in a comment. enforce.ts has said
// since it was written that "reducing and closing stay permitted always, because
// software that could not reduce risk once a limit was breached would be the
// opposite of a safety mechanism" — and until this route there was no code that
// could reduce anything. A hunter could enter a position through Hunt and had no
// way out of it except Perpl's own web app, with an in-app wallet they may not
// be able to connect there at all.
//
// THREE THINGS THIS ROUTE DELIBERATELY DOES NOT DO, each of which would rebuild
// the trap:
//
//   1. It does not gate on the Cota. No notional ceiling, no leverage check, no
//      daily-loss stop, no trades-per-day count, no expiry or revocation. The
//      hunter who most needs to cut risk is the one who has hit their limits.
//      See mayReduce.
//
//   2. It does not read the day-state. readDayState can return null when the
//      ledger and the venue disagree, and the trade route refuses on that —
//      correctly, because it is about to add risk on numbers it cannot vouch
//      for. A reduce needs no such vouching: the venue's own position frame says
//      what is held, and that is the only input. An unreconciled ledger must
//      never stop someone getting out.
//
//   3. It does not take a side. Closing a long is a sell and closing a short is
//      a buy; the sign of what is held decides, and a caller that could pass a
//      side could double a position while believing it was closing one.
//
// What it DOES enforce is arithmetic: you cannot reduce what you do not hold,
// and you cannot reduce past flat. Closing past flat opens exposure the other
// way, and that is new risk which belongs under mayOpen with the ceilings.
// ---------------------------------------------------------------------------

/**
 * GET /api/cota/close?market=MON — what is open, and what closing it would mean.
 *
 * Read-only, and it lives beside the POST on purpose: a hunter deciding whether
 * to close needs the position and its unrealised PnL from the same source the
 * close will act on, not from a ledger that may be a read behind. Entry comes
 * from the venue's own `ep` plus its Q16 residue `epr` — the position frame
 * carries both, and `ep` alone always rounds down. The residue is worth 0.35 bps
 * on 5273, which changes nobody's mind; it is included because it arrives for
 * free and because the rounding is one-directional.
 */
export async function GET(req: Request) {
  try {
    const player = await requirePlayer(req);
    const symbol = (
      new URL(req.url).searchParams.get("market") ?? "MON"
    ).toUpperCase();
    const market = executableMarket(symbol);
    if (!market) {
      return NextResponse.json(
        { error: `market ${symbol} is not supported yet` },
        { status: 400 },
      );
    }
    const cred = await loadPerpKey(player.id);
    if (!cred) return NextResponse.json({ position: null });

    const markUsd = await readMark(market.id, market.priceDecimals);
    const marks = new Map<number, MarkedMarket>([
      [market.id, { market, markUsd }],
    ]);
    const read = await readAccountPositions({
      apiKey: cred.apiKey,
      secretHex: cred.secretHex,
    });
    const frame = read.positions.find((p) => p.marketId === market.id);
    if (!frame) return NextResponse.json({ position: null, markUsd });

    const signedSize = signedSizeFromFrame(frame, marks);
    const entryUsd = entryUsdWithResidue(frame, market.priceDecimals);
    return NextResponse.json({
      position: {
        market: symbol,
        signedSize,
        side: signedSize < 0 ? "short" : "long",
        entryUsd,
        leverageX: frame.leverageX100 / 100,
        notionalUsd: Math.abs(signedSize) * markUsd,
        unrealisedUsd:
          entryUsd === null ? null : signedSize * (markUsd - entryUsd),
      },
      markUsd,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    console.error("[cota/close] position read failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}

const Input = z
  .object({
    market: z.string().min(1).max(16),
    /** Units to close. Omit to close the whole position. */
    sizeUnits: z.number().positive().finite().optional(),
    /**
     * A share of whatever is open, 0 < f <= 1, resolved HERE against the
     * position this request reads — not against one the browser read earlier.
     *
     * "Close half" is a statement about the position, not about a number of
     * units, and the page holds a copy that is up to a poll interval old. If a
     * fill lands or a liquidation trims the position in that window, half of
     * the stale size is not half of the real one. Sending the intent instead of
     * the arithmetic removes the window entirely.
     */
    fraction: z.number().positive().lte(1).optional(),
  })
  // Two ways to say the same thing invite a caller to say both and mean
  // neither.
  .refine((v) => !(v.sizeUnits !== undefined && v.fraction !== undefined), {
    message: "send sizeUnits or fraction, not both",
  });

export async function POST(req: Request) {
  try {
    const player = await requirePlayer(req);
    const parsed = Input.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: "bad request" }, { status: 400 });
    }
    const symbol = parsed.data.market.toUpperCase();
    const market = executableMarket(symbol);
    if (!market) {
      return NextResponse.json(
        { error: `market ${symbol} is not supported yet` },
        { status: 400 },
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
    const marks = new Map<number, MarkedMarket>([
      [market.id, { market, markUsd }],
    ]);

    let read;
    try {
      read = await readAccountPositions({
        apiKey: cred.apiKey,
        secretHex: cred.secretHex,
      });
    } catch {
      return NextResponse.json(
        { error: "could not read your position from the venue" },
        { status: 502 },
      );
    }

    const frame = read.positions.find((p) => p.marketId === market.id);
    const openSignedSize = frame ? signedSizeFromFrame(frame, marks) : 0;

    // A fraction is resolved against the size just read, so "half" always means
    // half of what is actually open. fraction 1 falls through to undefined —
    // the full-close path, which sends no size at all.
    const held = Math.abs(openSignedSize);
    const requestedUnits =
      parsed.data.fraction !== undefined && parsed.data.fraction < 1
        ? held * parsed.data.fraction
        : parsed.data.sizeUnits;

    const plan = planClose({
      market,
      openSignedSize,
      requestedUnits,
      markPriceUsd: markUsd,
    });
    if (!plan.decision.ok) {
      return NextResponse.json({
        allowed: false,
        reason: plan.decision.reason,
        openSignedSize,
        markUsd,
      });
    }

    // Forwarding still applies: with fw:false the gateway accepts an order the
    // chain will never execute, and a reduce is no more executable than an open.
    if (read.account && !read.account.forwardingAllowed) {
      return NextResponse.json({
        allowed: false,
        reason: "forwarding_disabled",
        openSignedSize,
        markUsd,
      });
    }

    const agentOrderId = newAgentOrderId();
    const result = await placeOrder({
      apiKey: cred.apiKey,
      secretHex: cred.secretHex,
      market,
      orderType: plan.orderType,
      sizeUnits: plan.sizeUnits,
      // The venue wants a leverage on every order frame. A close does not choose
      // one — it unwinds the position's own — so echo what the position carries
      // rather than invent a number that could read as a leverage change.
      leverageX: frame ? frame.leverageX100 / 100 : 1,
      feeBps: 0,
    });

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
            markUsd,
          ),
        );
      } catch (e) {
        console.error("[cota/close] fill record failed", e);
      }
    } else if (result.accepted && !venueRefusedOrder(result.update)) {
      try {
        await recordPlacedOrder(player.id, cred.account, {
          marketId: market.id,
          direction: directionOfOrderType(plan.orderType),
          sizeUnits: plan.sizeUnits,
          orderId: agentOrderId,
          venueConfirmedFill: venueConfirmedFill(result.update),
          venueStatus: result.update?.statusName ?? null,
        });
      } catch (e) {
        console.error("[cota/close] pending order record failed", e);
      }
    }

    if (!result.filled) {
      console.log(
        "[cota/close] not filled:",
        JSON.stringify({
          agentOrderId,
          accepted: result.accepted,
          code: result.code,
          error: result.error,
          venue: result.update,
          requestId: result.requestId,
          lfr: result.account?.lastRequestId ?? null,
        }),
      );
    }

    return NextResponse.json({
      allowed: true,
      accepted: result.accepted,
      filled: result.filled,
      code: result.code,
      error: result.error,
      fill: result.fill,
      venue: result.update,
      sizeUnits: plan.sizeUnits,
      full: plan.full,
      notionalUsd: plan.notionalUsd,
      openSignedSize,
      markUsd,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    console.error("[cota/close] failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}
