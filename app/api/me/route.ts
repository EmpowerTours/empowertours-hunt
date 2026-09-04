import { NextResponse } from "next/server";
import { createPublicClient, http } from "viem";
import { prisma } from "@/lib/db/prisma";
import { AuthError, clientIp, requirePlayer } from "@/lib/auth";
import { checkLimit } from "@/lib/ratelimit";
import { monad } from "@/lib/monad";
import { isClientAbort } from "@/lib/aborted";

// ---------------------------------------------------------------------------
// GET /api/me — what this player has, in one place.
//
// The client has called this since the wallet screen was written; the route
// never existed, so it 404'd into Next's HTML error page and the parser
// reported "malformed response". Same shape of gap as /api/hunts.
//
// ## Two different meanings of "balance", and the screen needs both
//
// The hunt's own bookkeeping — collected, pending — answers "what has this
// game promised me". The CHAIN answers "what do I actually hold". They differ
// whenever a payout is approved and not yet swept, which is most of the
// minutes after a collection, and a player looking at one while thinking about
// the other is how a working payout reads as a missing one.
//
// A chain read that fails returns null, never 0. "We could not ask" and "you
// have nothing" look identical as a number and could not be more different to
// somebody who just walked to a spawn.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

/** In flight: promised and not yet on chain. */
const PENDING_STATUSES = ["PENDING", "APPROVED", "SENDING"] as const;

export async function GET(req: Request) {
  try {
    const player = await requirePlayer(req);

    const limit = await checkLimit("browse", {
      playerId: player.id,
      ip: clientIp(req),
    });
    if (!limit.ok) {
      return NextResponse.json({ error: "slow down" }, { status: 429 });
    }

    const [row, sent, pending, findCount, spawnCount, payouts] = await Promise.all([
      prisma.player.findUniqueOrThrow({
        where: { id: player.id },
        select: {
          creditBalanceWei: true,
          turboUsername: true,
          walletAddress: true,
        },
      }),
      prisma.payout.aggregate({
        where: { playerId: player.id, status: "SENT" },
        _sum: { amountMonWei: true },
      }),
      prisma.payout.aggregate({
        where: { playerId: player.id, status: { in: [...PENDING_STATUSES] } },
        _sum: { amountMonWei: true },
      }),
      prisma.find.count({ where: { playerId: player.id } }),
      prisma.spawn.count({
        where: { playerId: player.id, collectedAt: { not: null } },
      }),
      // The receipts. A screen that says "3 MON settled" and offers no way to
      // check it asks the player to take the app's word for it — the wrong
      // posture for something whose whole claim is that it can be verified.
      prisma.payout.findMany({
        where: { playerId: player.id },
        orderBy: { createdAt: "desc" },
        take: 25,
        select: {
          id: true,
          status: true,
          amountMonWei: true,
          txHash: true,
          sentAt: true,
          createdAt: true,
        },
      }),
    ]);

    // Read last and separately: an RPC hiccup must not cost the player the
    // rest of this screen.
    let walletBalanceWei: string | null = null;
    try {
      const client = createPublicClient({
        chain: monad,
        transport: http(process.env.MONAD_RPC_URL),
      });
      const balance = await client.getBalance({
        address: row.walletAddress as `0x${string}`,
      });
      walletBalanceWei = balance.toString();
    } catch {
      // Stays null. See the note above about null versus zero.
    }

    return NextResponse.json({
      walletAddress: row.walletAddress,
      /** What the chain says, or null when it could not be asked. */
      walletBalanceWei,
      /** Paid and settled on chain. */
      collectedMonWei: (sent._sum.amountMonWei ?? 0).toString(),
      /** Owed and not yet swept — usually minutes, not an error. */
      pendingMonWei: (pending._sum.amountMonWei ?? 0).toString(),
      creditBalanceWei: row.creditBalanceWei.toFixed(0),
      findCount,
      spawnCount,
      turboUsername: row.turboUsername,
      payouts: payouts.map((p) => ({
        id: p.id,
        status: p.status,
        amountMonWei: p.amountMonWei.toFixed(0),
        // Null until the keeper broadcasts. The UI says "on its way" rather
        // than showing an empty link, because a dead link reads as a failure.
        txHash: p.txHash,
        at: (p.sentAt ?? p.createdAt).toISOString(),
      })),
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    if (isClientAbort(err)) return new Response(null, { status: 499 });
    console.error("[me] GET failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}
