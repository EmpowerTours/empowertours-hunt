import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requirePlayer } from "@/lib/auth";
import { prisma } from "@/lib/db/prisma";
import {
  proposeOrder,
  ProposerError,
  type MarketSnapshot,
} from "@/lib/cota/propose";
import { MON_MARKET } from "@/lib/cota/order";
import { readMark } from "@/lib/cota/venue/market-data";
import { type DayState, type EnforcedBound } from "@/lib/cota/enforce";

// ---------------------------------------------------------------------------
// POST /api/cota/propose — Kimi proposes one order within the hunter's leash.
//
// Loads the active Cota, gathers a live mark for each pinned market it names,
// and asks proposeOrder (Kimi + the mayOpen gate) for a suggestion. Kimi has no
// authority: the returned `decision` is the leash's verdict, identical to what
// the trade route enforces. The UI fills its form from `proposal` and shows
// `decision`. A missing key / API error surfaces as 503, never a silent trade.
// ---------------------------------------------------------------------------

const FRESH_DAY: DayState = {
  tradesToday: 0,
  lossTodayUsdE6: 0n,
  openNotionalUsdE6: 0n,
};

const MARKET_PINS: Record<string, { id: number; priceDecimals: number }> = {
  MON: { id: MON_MARKET.id, priceDecimals: MON_MARKET.priceDecimals },
};

const Input = z.object({
  digest: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .optional(),
});

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
    const parsed = Input.safeParse(await req.json().catch(() => ({})));
    const digest = parsed.success ? parsed.data.digest : undefined;

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

    // Live mark per named market; an unpinned or unreadable market still goes
    // to Kimi with a 0 price so it can propose on the symbol (the gate is what
    // ultimately binds the proposal).
    const markets: MarketSnapshot[] = [];
    for (const sym of cota.markets) {
      const pin = MARKET_PINS[sym.toUpperCase()];
      let priceUsd = 0;
      if (pin) {
        try {
          priceUsd = await readMark(pin.id, pin.priceDecimals, {
            timeoutMs: 6000,
          });
        } catch {
          priceUsd = 0;
        }
      }
      markets.push({ market: sym, priceUsd });
    }

    const result = await proposeOrder({
      bound: boundFromRow(cota),
      state: FRESH_DAY,
      markets,
      nowSeconds: BigInt(Math.floor(Date.now() / 1000)),
    });

    return NextResponse.json({
      proposal: result.proposal,
      decision: result.decision,
    });
  } catch (err) {
    if (err instanceof ProposerError) {
      return NextResponse.json(
        { error: "proposer unavailable", detail: err.message },
        { status: 503 },
      );
    }
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    console.error("[cota/propose] failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}
