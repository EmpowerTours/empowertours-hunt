import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { prisma } from "@/lib/db/prisma";
import { foldSpot, type SpotTrade } from "@/lib/cota/spot-pnl";

// ---------------------------------------------------------------------------
// What a wallet's Kuru trades realised.
//
// DATABASE ONLY, like every other read on this side: the rows were written from
// receipts at record time, so nothing here needs a key, a venue session or an
// RPC. Unauthenticated for the same reason /api/cota/kuru/history is — every
// figure underneath is already on a public chain, and a wallet owner checking
// their own books should not need a session to do it.
// ---------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const wallet = new URL(req.url).searchParams.get("wallet");
  if (!wallet || !isAddress(wallet)) {
    return NextResponse.json({ error: "wallet required" }, { status: 400 });
  }

  const rows = await prisma.kuruSwap.findMany({
    where: { wallet: wallet.toLowerCase() },
    // Ordered here AND in the fold. The fold has to sort anyway — it is pure
    // and cannot trust its caller — but fetching in order keeps the two from
    // ever looking like they disagree.
    orderBy: { at: "asc" },
    select: {
      hash: true,
      side: true,
      ok: true,
      valueWei: true,
      nativeInWei: true,
      tokensIn: true,
      tokensOut: true,
      gasWei: true,
      at: true,
    },
  });

  const r = foldSpot(rows as unknown as SpotTrade[]);

  return NextResponse.json({
    // Wei and 6dp as decimal strings: JSON cannot carry a bigint, and anyone
    // reconciling against the chain needs the exact figure rather than a float.
    realisedUsd6: r.realised6.toString(),
    netMonWei: r.netMonWei.toString(),
    gasWei: r.gasWei.toString(),
    openMonWei: r.openMonWei.toString(),
    openBasisUsd6: r.openBasis6.toString(),
    unpriced: r.unpriced,
    trades: rows.length,
    disposals: r.disposals.map((d) => ({
      hash: d.hash,
      at: d.at.toISOString(),
      monWei: d.monWei.toString(),
      proceedsUsd6: d.proceeds6.toString(),
      basisUsd6: d.basis6.toString(),
      realisedUsd6: d.realised6.toString(),
    })),
  });
}
