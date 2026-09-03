import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { AuthError, clientIp, requirePlayer } from "@/lib/auth";
import { checkLimit } from "@/lib/ratelimit";
import { validatePosition } from "@/lib/hunt/validator";

// ---------------------------------------------------------------------------
// POST /api/hunt/[huntId]/checkin — establish a verified position, earn nothing.
//
// ## Why this exists
//
// `PlayerHunt.lastVerified*` was written in exactly two places: accepting a
// cache find, and collecting a spawn. Spawns anchor to that fix, so the loop
// sustains itself once started — but the FIRST fix could only come from a
// human-planted cache. A player in a city nobody had seeded could not play at
// all, however much MON sat in the treasury. This is the bootstrap.
//
// ## What it changes about the threat model, stated plainly
//
// A cache find is hard to fake because the cache position is SECRET — that is
// the find economy's whole defence. A check-in has no secret to hit, so its
// only defence is movement plausibility: a spoofer can claim to be anywhere,
// they just cannot teleport between fixes.
//
// What bounds the loss is not this route. It is `spawnDailyCapWeiPerPlayer`,
// `budgetMonWei`, the spawn cooldown, and `autoApproveMaxWei` sitting at 0 —
// and under those, a spoofer's daily take is exactly an honest player's. That
// is the argument for opening this up: spoofing was never what kept the
// treasury solvent, the caps were.
//
// It pays NOTHING. No credit, no MON, no Payout row. A position is not an
// achievement, and paying for one would make spoofing worth doing for its own
// sake rather than only as a way to reach a capped spawn.
// ---------------------------------------------------------------------------

const CheckIn = z.object({
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
  accuracyM: z.number().finite().nonnegative(),
  clientTs: z.number().int().positive(),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ huntId: string }> },
) {
  try {
    const player = await requirePlayer(req);

    // Same bucket as claims. A check-in is cheaper than a claim but it is the
    // step that unlocks the spawn path, so it gets the tighter of the two.
    const limit = await checkLimit("claim", {
      playerId: player.id,
      ip: clientIp(req),
    });
    if (!limit.ok) {
      return NextResponse.json({ error: "slow down" }, { status: 429 });
    }

    const { huntId } = await ctx.params;
    const parsed = CheckIn.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "bad request" }, { status: 400 });
    }
    const input = parsed.data;

    const hunt = await prisma.hunt.findUnique({
      where: { id: huntId },
      select: {
        id: true,
        active: true,
        startsAt: true,
        endsAt: true,
        maxAccuracyM: true,
        maxSpeedKmh: true,
        cooldownSeconds: true,
        maxClockSkewSeconds: true,
      },
    });
    if (hunt === null) {
      return NextResponse.json({ error: "hunt not found" }, { status: 404 });
    }

    const stats = await prisma.playerHunt.findUnique({
      where: { huntId_playerId: { huntId, playerId: player.id } },
      select: {
        lastVerifiedLat: true,
        lastVerifiedLng: true,
        lastVerifiedAt: true,
      },
    });

    const serverNow = new Date();

    // The anti-teleport reference is the last VERIFIED fix, not the last find:
    // a spawn collect and a previous check-in both set one, and reading only
    // finds would let a player alternate mechanics to dodge the speed check.
    const lastFix =
      stats?.lastVerifiedLat != null &&
      stats.lastVerifiedLng != null &&
      stats.lastVerifiedAt != null
        ? {
            lat: stats.lastVerifiedLat,
            lng: stats.lastVerifiedLng,
            foundAt: stats.lastVerifiedAt,
          }
        : null;

    const result = validatePosition({
      attempt: {
        lat: input.lat,
        lng: input.lng,
        accuracyM: input.accuracyM,
        clientTs: new Date(input.clientTs),
      },
      serverNow,
      playerActive: player.active && player.suspendedAt === null,
      huntActive: hunt.active,
      huntStartsAt: hunt.startsAt,
      huntEndsAt: hunt.endsAt,
      lastFix,
      rules: {
        maxAccuracyM: hunt.maxAccuracyM,
        maxSpeedKmh: hunt.maxSpeedKmh,
        cooldownSeconds: hunt.cooldownSeconds,
        maxClockSkewSeconds: hunt.maxClockSkewSeconds,
      },
    });

    if (!result.ok) {
      // The reason is returned in full here, unlike a claim rejection, which is
      // deliberately opaque so a prober cannot binary-search a cache position.
      // Nothing about a check-in is secret — there is no cache involved — and a
      // player standing outdoors needs to know it was their GPS accuracy.
      // 200, not 409. A refusal here is an ordinary outcome — the same shape
      // submitClaim already uses for a claim that found nothing. An HTTP error
      // would make the client throw, and the reason a player most needs ("your
      // GPS is not accurate enough yet") is the one that would be lost.
      return NextResponse.json({
        ok: false,
        reason: result.reason,
        detail: result.detail,
      });
    }

    await prisma.playerHunt.upsert({
      where: { huntId_playerId: { huntId, playerId: player.id } },
      create: {
        huntId,
        playerId: player.id,
        lastVerifiedLat: input.lat,
        lastVerifiedLng: input.lng,
        lastVerifiedAt: serverNow,
      },
      update: {
        lastVerifiedLat: input.lat,
        lastVerifiedLng: input.lng,
        lastVerifiedAt: serverNow,
      },
    });

    return NextResponse.json({
      ok: true,
      verifiedAt: serverNow.toISOString(),
      speedKmh: result.speedKmh,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    console.error("[checkin] POST failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}
