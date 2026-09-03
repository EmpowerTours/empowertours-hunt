import { NextResponse } from "next/server";
import { isClientAbort } from "@/lib/aborted";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requirePlayer, clientIp, AuthError } from "@/lib/auth";
import { checkLimit } from "@/lib/ratelimit";
import { proximityHint, type HintCandidate } from "@/lib/hunt/proximity";

// A hint is a distance oracle even after quantization. The mitigations live in
// lib/hunt/proximity.ts (grid snapping, nearest-only, per-edge jitter) and are
// documented there; this route's job is the three that cannot be pure:
//
//   * rate limiting, through the shared limiter so it survives more than one
//     instance — the previous in-memory Map limited nothing as soon as Railway
//     ran two containers, and volume is what defeats quantization;
//   * the hunt time window, so caches cannot be located before a hunt opens or
//     after it closes, when nobody is watching and the probe costs nothing;
//   * a HintRequest row per probe, so a grid search is visible in the admin
//     queue instead of leaving no trace at all.

const HintInput = z.object({
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ huntId: string }> },
) {
  const { huntId } = await params;

  try {
    const player = await requirePlayer(req);

    // Before the eligibility check, before the body is parsed, and before any
    // cache is read. A suspended wallet probing the oracle is exactly the
    // caller who should meet the limiter first.
    const limit = await checkLimit("hint", {
      playerId: player.id,
      ip: clientIp(req),
    });
    if (!limit.ok) {
      return NextResponse.json(
        { error: "slow down" },
        {
          status: 429,
          headers: {
            "Retry-After": String(
              Math.max(0, Math.ceil((limit.resetAt - Date.now()) / 1000)),
            ),
          },
        },
      );
    }

    if (!player.active || player.suspendedAt !== null) {
      return NextResponse.json({ error: "not eligible" }, { status: 403 });
    }

    const input = HintInput.parse(await req.json());
    const now = new Date();

    const hunt = await prisma.hunt.findUnique({
      where: { id: huntId },
      include: {
        caches: {
          // suspendedAt too: a hint for a suspended cache would walk somebody
          // toward a reward that has been taken down, which is the takedown
          // failing in the most public way available.
          where: { active: true, suspendedAt: null },
          // Only what the hint needs. Selecting the full row here is how
          // coordinates end up in a response by accident later.
          select: { id: true, lat: true, lng: true },
        },
      },
    });

    // The window matters as much as the flag. `active` alone let a player
    // probe a configured-but-unopened hunt and have every cache located before
    // it started — the same oracle, run without competition. One 404 covers
    // all four cases so the shape of the error says nothing about which one
    // it was.
    const open =
      hunt !== null &&
      hunt.active &&
      (hunt.startsAt === null || now >= hunt.startsAt) &&
      (hunt.endsAt === null || now <= hunt.endsAt);
    if (!hunt || !open) {
      return NextResponse.json(
        { error: "hunt not available" },
        { status: 404 },
      );
    }

    const found = await prisma.find.findMany({
      where: { huntId, playerId: player.id },
      select: { cacheId: true },
    });
    const foundSet = new Set(found.map((f) => f.cacheId));
    const unfound: HintCandidate[] = hunt.caches.filter(
      (c) => !foundSet.has(c.id),
    );

    // The grid secret makes the snapping lattice unpredictable rather than
    // merely stable. Absent it the mitigation still holds (a player's own
    // probes still collapse to cells, and two players still disagree), so the
    // route degrades rather than failing — but set HINT_GRID_SECRET in
    // production. It is read from env, never hardcoded, and never logged.
    const gridSecret = process.env.HINT_GRID_SECRET ?? "";
    const hint = proximityHint(input, unfound, player.id, gridSecret);

    // Log the RAW submitted position, not the snapped one: the raw points are
    // what reveal a grid search or a boundary walk. This is the only place the
    // raw probe is recorded, and it is admin-only.
    await prisma.hintRequest.create({
      data: {
        huntId,
        playerId: player.id,
        lat: input.lat,
        lng: input.lng,
        band: hint?.band ?? null,
      },
    });

    if (!hint) {
      // "You found everything" and "there is nothing here" are different
      // facts, and conflating them told a player on a spawn-only hunt that
      // every cache was theirs and there was nothing left to claim — on a
      // hunt that has never had a cache in it. Reported from the street.
      //
      // `complete` stays FALSE when the hunt holds no caches: completing
      // nothing is not an achievement, and the claim button should not read
      // as finished.
      const cacheless = hunt.caches.length === 0;
      return NextResponse.json({
        complete: !cacheless,
        cacheless,
        remaining: 0,
        band: null,
      });
    }

    // Band and count only. No coordinates, no distance, no cache id — a cache
    // id here would let a player pin which band belongs to which cache and
    // trilaterate them one at a time.
    return NextResponse.json({
      complete: false,
      cacheless: false,
      band: hint.band,
      remaining: hint.remaining,
    });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: 401 });
    }
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: "invalid payload" }, { status: 400 });
    }
    // A cancelled fetch is the hint hook doing its job, not a fault.
    if (isClientAbort(e)) return new Response(null, { status: 499 });
    console.error("[hunt/hint]", e);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
