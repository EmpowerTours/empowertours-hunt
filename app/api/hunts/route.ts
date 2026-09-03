import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { AuthError, clientIp, requirePlayer } from "@/lib/auth";
import { checkLimit } from "@/lib/ratelimit";
import {
  PUBLIC_HUNT_SELECT,
  isListable,
  remainingFinds,
  toPublicHunt,
} from "@/lib/hunt/publicHunt";

// ---------------------------------------------------------------------------
// GET /api/hunts — the hunt list.
//
// The client (components/hunt/client.ts) was written against this contract
// before the route existed and degrades to "not built yet" without it, which
// is why the browse screen has been showing an error: a missing route returns
// Next's HTML 404 where JSON was expected.
//
// ## Public on purpose
//
// No session required. Somebody arriving from a link should see that hunts
// exist before deciding whether to make a wallet — gating the list behind
// sign-in asks a stranger to authenticate before showing them anything worth
// authenticating for. Nothing here is secret: cache locations are never in
// this payload (see lib/hunt/publicHunt.ts).
//
// A signed-in caller additionally gets `remaining`, their own finds left.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const limit = await checkLimit("browse", { ip: clientIp(req) });
    if (!limit.ok) {
      return NextResponse.json({ error: "slow down" }, { status: 429 });
    }

    // Identity is optional here. An AuthError means "browsing anonymously",
    // which is a supported state, not a failure.
    let playerId: string | null = null;
    try {
      playerId = (await requirePlayer(req)).id;
    } catch (err) {
      if (!(err instanceof AuthError)) throw err;
    }

    const now = new Date();

    const rows = await prisma.hunt.findMany({
      where: {
        active: true,
        OR: [{ endsAt: null }, { endsAt: { gte: now } }],
      },
      orderBy: [{ startsAt: "asc" }, { name: "asc" }],
      take: 50,
      select: { ...PUBLIC_HUNT_SELECT, maxFindsPerPlayer: true },
    });

    // One query for every hunt's counter rather than one per hunt.
    const stats =
      playerId === null
        ? []
        : await prisma.playerHunt.findMany({
            where: { playerId, huntId: { in: rows.map((r) => r.id) } },
            select: { huntId: true, findCount: true },
          });
    const findCounts = new Map(stats.map((s) => [s.huntId, s.findCount]));

    const hunts = rows
      .filter((row) => isListable(row, now))
      .map((row) =>
        toPublicHunt(
          row,
          playerId === null
            ? undefined
            : remainingFinds(
                row.maxFindsPerPlayer,
                findCounts.get(row.id) ?? 0,
              ),
        ),
      );

    return NextResponse.json({ hunts });
  } catch (err) {
    console.error("[hunts] GET failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}
