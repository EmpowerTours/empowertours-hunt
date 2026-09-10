import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requirePlayer } from "@/lib/auth";
import { prisma } from "@/lib/db/prisma";
import { loadPerpKey } from "@/lib/cota/keystore";
import { MON_MARKET, planOpen, type Market } from "@/lib/cota/order";
import { placeOrder } from "@/lib/cota/venue/client";
import { readMark } from "@/lib/cota/venue/market-data";
import {
  explainDenial,
  type DayState,
  type EnforcedBound,
} from "@/lib/cota/enforce";

// ---------------------------------------------------------------------------
// POST /api/cota/trade — place one bounded order for the signed-in hunter.
//
// Flow: load the active Cota → load the server-held trading key → read the mark
// → plan+GATE the order (enforce.ts) → and ONLY if the leash allows it, place
// it on the venue. The gate runs before the transport; there is no path that
// reaches placeOrder without passing mayOpen.
//
// SCOPE NOTE (follow-up): the gate uses a clean day-state, so it enforces the
// PER-ORDER caps — authorised market, per-order notional, leverage, validity
// window, revocation. It does NOT yet enforce the AGGREGATE open-notional or
// daily-loss ceilings, which need a live positions/PnL read (the piece Mandate
// does in cota.py before it calls /api/cota/check). Wire that read in before
// relying on this for size/loss limits across multiple concurrent positions.
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

const FRESH_DAY: DayState = {
  tradesToday: 0,
  lossTodayUsdE6: 0n,
  openNotionalUsdE6: 0n,
};

interface CotaRow {
  venue: string;
  markets: string[];
  maxNotionalUsdE6: { toString(): string };
  maxLeverageX100: { toString(): string };
  maxDailyLossUsdE6: { toString(): string };
  maxTradesPerDay: number;
  notBefore: Date;
  notAfter: Date;
  revokedAt: Date | null;
}

function boundFromRow(c: CotaRow): EnforcedBound {
  return {
    venue: c.venue,
    markets: c.markets,
    maxNotionalUsdE6: BigInt(c.maxNotionalUsdE6.toString()),
    maxLeverageX100: BigInt(c.maxLeverageX100.toString()),
    maxDailyLossUsdE6: BigInt(c.maxDailyLossUsdE6.toString()),
    maxTradesPerDay: c.maxTradesPerDay,
    notBefore: BigInt(Math.floor(c.notBefore.getTime() / 1000)),
    notAfter: BigInt(Math.floor(c.notAfter.getTime() / 1000)),
    revokedAt: c.revokedAt,
  };
}

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

    const plan = planOpen({
      bound: boundFromRow(cota),
      state: FRESH_DAY,
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

    const result = await placeOrder({
      apiKey: cred.apiKey,
      secretHex: cred.secretHex,
      market,
      orderType: plan.orderType,
      sizeUnits: plan.sizeUnits,
      leverageX,
      feeBps: BUILDER_FEE_BPS,
    });

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
