import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { AuthError, clientIp, requirePlayer } from "@/lib/auth";
import { checkLimit } from "@/lib/ratelimit";
import { mayPlantCache } from "@/lib/hunt/sembrador";

// ---------------------------------------------------------------------------
// POST /api/hunts/[huntId]/caches — a Sembrador plants a cache in their hunt.
//
// ## Only the creator, and only their own hunt
//
// Ownership is checked against `createdByPlayerId`, which is null on every
// admin-made hunt. A null owner therefore matches nobody, so this route cannot
// be used to plant caches into the hunts that already exist — those stay
// admin-only, which is the correct default for a column that was backfilled
// with nothing.
//
// ## The separation check is read-then-write, and that is acknowledged
//
// Two simultaneous plants can each read the same existing set and both pass
// the 60m rule, ending up closer than that. The consequence is two caches too
// close together — an abuse limit softened, not money moved — so it is not
// worth the locking that the credit and spawn ceilings genuinely need. Stating
// it beats a comment claiming an atomicity this does not have.
//
// Coordinates go IN here and must never come back out: the response echoes the
// id and nothing else.
// ---------------------------------------------------------------------------

const PlantCache = z.object({
  lat: z.number(),
  lng: z.number(),
  radiusMeters: z.number().int().default(25),
  label: z.string().trim().max(80).optional(),
  blurb: z.string().trim().max(500).optional(),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ huntId: string }> },
) {
  try {
    const player = await requirePlayer(req);

    const limit = await checkLimit("cota", {
      playerId: player.id,
      ip: clientIp(req),
    });
    if (!limit.ok) {
      return NextResponse.json({ error: "slow down" }, { status: 429 });
    }

    const { huntId } = await ctx.params;
    const parsed = PlantCache.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "bad request" }, { status: 400 });
    }
    const input = parsed.data;

    const hunt = await prisma.hunt.findUnique({
      where: { id: huntId },
      select: { id: true, createdByPlayerId: true },
    });

    // 404 rather than 403 for a hunt somebody does not own. A distinct
    // "exists but not yours" reply lets anybody enumerate which hunt ids are
    // real, and there is nothing a non-owner can do with that.
    if (hunt === null || hunt.createdByPlayerId !== player.id) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const existing = await prisma.cache.findMany({
      where: { huntId, active: true },
      select: { lat: true, lng: true },
    });

    const allowed = mayPlantCache({
      lat: input.lat,
      lng: input.lng,
      radiusMeters: input.radiusMeters,
      existing,
    });
    if (!allowed.ok) {
      return NextResponse.json({ error: allowed.reason }, { status: 409 });
    }

    const cache = await prisma.cache.create({
      data: {
        huntId,
        lat: input.lat,
        lng: input.lng,
        radiusMeters: input.radiusMeters,
        label: input.label ?? null,
        blurb: input.blurb ?? null,
        // Pays nothing until the hunt is funded. A cache that promised credit
        // the hunt has no budget for would fail at claim time, after the walk.
        rewardCreditWei: 0,
      },
      select: { id: true },
    });

    return NextResponse.json({ ok: true, cache }, { status: 201 });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    console.error("[caches] POST failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}

/**
 * GET — the Sembrador's own caches, coordinates included.
 *
 * The one place cache locations legitimately leave the server: they are this
 * player's own plants, and they cannot manage a hunt they cannot see. Guarded
 * by the same ownership check, which is why that check is the only thing
 * standing between this and the secret the whole find economy rests on.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ huntId: string }> },
) {
  try {
    const player = await requirePlayer(req);
    const { huntId } = await ctx.params;

    const hunt = await prisma.hunt.findUnique({
      where: { id: huntId },
      select: { createdByPlayerId: true },
    });
    if (hunt === null || hunt.createdByPlayerId !== player.id) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const caches = await prisma.cache.findMany({
      where: { huntId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        lat: true,
        lng: true,
        radiusMeters: true,
        label: true,
        active: true,
        suspendedAt: true,
        createdAt: true,
      },
    });

    return NextResponse.json({ caches });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    console.error("[caches] GET failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}
