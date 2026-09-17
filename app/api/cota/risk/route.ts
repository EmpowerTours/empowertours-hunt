import { NextResponse } from "next/server";
import { AuthError, requirePlayer } from "@/lib/auth";
import { prisma } from "@/lib/db/prisma";
import { loadPerpKey } from "@/lib/cota/keystore";
import { executableMarket } from "@/lib/cota/order";
import { readMark, readBook, exitPriceFor } from "@/lib/cota/venue/market-data";
import { readAccountPositions } from "@/lib/cota/venue/account-read";
import {
  entryUsdWithResidue,
  signedSizeFromFrame,
} from "@/lib/cota/venue/aggregate";
import type { MarkedMarket } from "@/lib/cota/venue/account-state";
import { readDayState } from "@/lib/cota/day-state";
import { boundFromRow } from "@/lib/cota/bound";
import { liveLeashWhere, tradableMarketOf } from "@/lib/cota/active-leash";
import { exitMath } from "@/lib/cota/exit";
import { verifyStoredGrant } from "@/lib/cota/autonomy";

// ---------------------------------------------------------------------------
// GET /api/cota/risk — everything a hunter needs to judge their own exposure,
// read from the venue in one pass.
//
// ## What it deliberately does NOT report: a liquidation price
//
// The market config carries `maintenance_margin: 2000`, and Perpl's own type
// reference documents the units inconsistently — it says `initial_margin` 1000
// means 10% (implying a 10,000 divisor) and in the next line that
// `maintenance_margin` 2000 means 5% (implying the number is a divisor itself).
// Those cannot both be true, and a liquidation price computed from the wrong one
// is off by a factor of four in the direction that tells somebody they are safe.
//
// A risk dashboard that invents its most alarming number is worse than one that
// omits it, so this omits it and says why. Everything below is either read
// directly off the venue or computed from two numbers that are.
//
// ## The number that IS here and usually is not: realisable PnL
//
// Dashboards show unrealised PnL against the mark. A hunter cannot get the mark:
// they get the bid if they are long, minus fees already paid, minus the fee to
// close. On MON that gap is about 30 bps — the difference between a position
// that looks green and one that pays out red. `closeNowUsd` is what closing
// right now would actually put in their account.
// ---------------------------------------------------------------------------

export async function GET(req: Request) {
  try {
    const player = await requirePlayer(req);

    const cota = await prisma.cota.findFirst({
      where: liveLeashWhere(player.id),
      orderBy: { createdAt: "desc" },
    });
    if (!cota) return NextResponse.json({ leash: null });

    const symbol = tradableMarketOf(cota);
    const market = symbol ? executableMarket(symbol) : undefined;
    const cred = await loadPerpKey(player.id);
    if (!market || !cred) {
      return NextResponse.json({ leash: { digest: cota.digest }, venue: null });
    }

    const markUsd = await readMark(market.id, market.priceDecimals);
    const marks = new Map<number, MarkedMarket>([
      [market.id, { market, markUsd }],
    ]);
    const [book, read] = await Promise.all([
      readBook(market.id, market.priceDecimals),
      readAccountPositions({
        apiKey: cred.apiKey,
        secretHex: cred.secretHex,
      }),
    ]);

    const frame = read.positions.find((p) => p.marketId === market.id);
    const signedSize = frame ? signedSizeFromFrame(frame, marks) : 0;
    const entryUsd = frame
      ? entryUsdWithResidue(frame, market.priceDecimals)
      : null;
    const exitPriceUsd = book ? exitPriceFor(signedSize, book) : null;
    const feesPaidUsd = frame ? (frame.feeScaled ?? 0) / 1_000_000 : 0;

    // What closing RIGHT NOW would realise — the number the hunter actually
    // gets, not the one the mark implies.
    const closeNow =
      frame && entryUsd !== null && exitPriceUsd !== null
        ? exitMath({ signedSize, entryUsd, exitPriceUsd, feesPaidUsd })
        : null;

    const day = await readDayState({
      playerId: player.id,
      account: cred.account,
      apiKey: cred.apiKey,
      secretHex: cred.secretHex,
      marks,
      nowMs: Date.now(),
    }).catch(() => null);

    const bound = boundFromRow(cota);
    const grant = await verifyStoredGrant({
      stored: cota.autonomy,
      cotaDigest: cota.digest,
      signature: cota.autonomySignature,
      nonce: cota.autonomyNonce,
      notAfter: cota.autonomyNotAfter,
      walletAddress: player.walletAddress,
    });

    const recent = await prisma.cotaAgentDecision.findMany({
      where: { playerId: player.id, cotaDigest: cota.digest },
      orderBy: { at: "desc" },
      take: 12,
      select: { id: true, act: true, why: true, dryRun: true, at: true },
    });

    const usd6 = (v: bigint | null | undefined) =>
      v === null || v === undefined ? null : Number(v) / 1e6;

    return NextResponse.json({
      market: symbol,
      markUsd,
      book,
      leash: {
        digest: cota.digest,
        anchorTxHash: cota.anchorTxHash,
        notAfter: cota.notAfter,
        maxNotionalUsd: Number(bound.maxNotionalUsdE6) / 1e6,
        maxLeverageX: Number(bound.maxLeverageX100) / 100,
        maxDailyLossUsd: Number(bound.maxDailyLossUsdE6) / 1e6,
        maxTradesPerDay: bound.maxTradesPerDay,
      },
      used: {
        openNotionalUsd: usd6(day?.dayState?.openNotionalUsdE6),
        tradesToday: day?.dayState?.tradesToday ?? null,
        // Null here is NOT zero — it means loss could not be vouched for, and
        // the leash is refusing opens because of it. The UI must say so rather
        // than draw an empty bar.
        lossTodayUsd: usd6(day?.dayState?.lossTodayUsdE6),
        lossVerifiable: day?.dayState != null,
      },
      position: frame
        ? {
            side: signedSize < 0 ? "short" : "long",
            sizeUnits: Math.abs(signedSize),
            entryUsd,
            leverageX: frame.leverageX100 / 100,
            collateralUsd: null,
            feesPaidUsd,
            exitPriceUsd,
            notionalUsd: Math.abs(signedSize) * markUsd,
            markPnlUsd:
              entryUsd === null ? null : signedSize * (markUsd - entryUsd),
            closeNowUsd: closeNow?.netUsd ?? null,
            closeNowBps: closeNow?.netBps ?? null,
          }
        : null,
      venue: read.account
        ? {
            accountId: read.account.accountId,
            forwardingAllowed: read.account.forwardingAllowed,
            frozen: read.account.frozen,
            balanceUsd: read.account.balance / 1e6,
            lockedUsd: read.account.locked / 1e6,
            availableUsd: read.account.available / 1e6,
          }
        : null,
      agent: { mode: grant.mode, notAfter: cota.autonomyNotAfter, recent },
      // Said out loud rather than left as an absence.
      omitted: {
        liquidationPrice:
          "not shown: Perpl documents initial_margin and maintenance_margin in contradictory units, and a liquidation price from the wrong one errs toward telling you that you are safe",
      },
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    console.error("[cota/risk] failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}
