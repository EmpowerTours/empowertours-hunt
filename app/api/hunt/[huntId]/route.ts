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
// GET /api/hunt/[huntId] — one hunt.
//
// The client's own comment on this endpoint is "Must not return caches", and
// that is enforced structurally rather than by remembering: the select list is
// PUBLIC_HUNT_SELECT, a shared constant with no cache relation in it, so
// adding a field here cannot accidentally pull locations along with it.
//
// A hunt that is inactive or already over 404s rather than returning a body a
// player cannot act on. Same reason the list hides them — a screen offering a
// hunt nobody can claim on is worse than an empty screen.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ huntId: string }> },
) {
  try {
    const limit = await checkLimit("browse", { ip: clientIp(req) });
    if (!limit.ok) {
      return NextResponse.json({ error: "slow down" }, { status: 429 });
    }

    const { huntId } = await ctx.params;

    let playerId: string | null = null;
    try {
      playerId = (await requirePlayer(req)).id;
    } catch (err) {
      if (!(err instanceof AuthError)) throw err;
    }

    const row = await prisma.hunt.findUnique({
      where: { id: huntId },
      select: { ...PUBLIC_HUNT_SELECT, maxFindsPerPlayer: true },
    });

    const now = new Date();
    if (row === null || !isListable(row, now)) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    let remaining: number | undefined;
    if (playerId !== null) {
      const stat = await prisma.playerHunt.findUnique({
        where: { huntId_playerId: { huntId, playerId } },
        select: { findCount: true },
      });
      remaining = remainingFinds(row.maxFindsPerPlayer, stat?.findCount ?? 0);
    }

    return NextResponse.json({ hunt: toPublicHunt(row, remaining) });
  } catch (err) {
    console.error("[hunt] GET failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}
