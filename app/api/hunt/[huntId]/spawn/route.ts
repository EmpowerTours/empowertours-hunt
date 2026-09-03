import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db/prisma";
import { requirePlayer, AuthError, clientIp } from "@/lib/auth";
import { checkLimit } from "@/lib/ratelimit";
import { toWei, fromWei } from "@/lib/wei";
import {
  evaluateSpawnEligibility,
  deriveSeed,
  commitSeed,
  deriveSpawnInArea,
} from "@/lib/hunt/spawn";
import type { Ring } from "@/lib/geo/polygon";

// Ask for a spawn, and see the ones already on your radar.
//
// Spawn coordinates ARE public — the mechanic is watching one appear — so
// unlike the claim and hint routes this one is not a location oracle and does
// not have to lie about anything. What it does have to get right:
//
//   * Placement anchors on PlayerHunt.lastVerified*, the last position the
//     VERIFIER accepted. NOTHING in the request body influences where a spawn
//     lands. A route that placed a spawn at the caller's self-reported
//     position would let a spoofer summon money to any coordinate on earth,
//     and no amount of movement checking afterwards would fix that.
//   * The cooldown is an atomic conditional UPDATE, not a read-then-write. Two
//     concurrent requests must produce one spawn.
//   * The amount comes from a server CSPRNG under a published commitment.
//
// This route does not move money. It creates a debt-in-waiting: the Spawn row.
// Money is decided at collect and sent, after approval, by /api/cron/payouts.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * How old the last verified fix may be and still anchor a spawn.
 *
 * Should become a Hunt column — proposing that to whoever owns the schema
 * rather than editing a shared file. Until then this is deliberately short: a
 * stale anchor drops spawns around where somebody used to be, which is both a
 * bad game and a small teleport allowance.
 */
const MAX_VERIFIED_FIX_AGE_SECONDS = 1800;

interface SpawnView {
  id: string;
  lat: number;
  lng: number;
  radiusMeters: number;
  amountMonWei: string;
  seedCommit: string;
  expiresAt: string;
}

function view(s: {
  id: string;
  lat: number;
  lng: number;
  radiusMeters: number;
  amountMonWei: unknown;
  seedCommit: string;
  expiresAt: Date;
}): SpawnView {
  return {
    id: s.id,
    lat: s.lat,
    lng: s.lng,
    radiusMeters: s.radiusMeters,
    // Through lib/wei so a Decimal past 1e21 is not stringified as "1e+21".
    amountMonWei: fromWei(toWei(s.amountMonWei as string)),
    seedCommit: s.seedCommit,
    expiresAt: s.expiresAt.toISOString(),
  };
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ huntId: string }> },
) {
  const { huntId } = await params;

  try {
    const player = await requirePlayer(req);

    // Before any read of the hunt. A spawn request is cheap for the caller and
    // not free for us, and this is a money path.
    const limit = await checkLimit("spawn", {
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

    const now = new Date();

    const hunt = await prisma.hunt.findUnique({ where: { id: huntId } });
    if (!hunt) {
      return NextResponse.json({ error: "hunt not found" }, { status: 404 });
    }

    const stats = await prisma.playerHunt.findUnique({
      where: { huntId_playerId: { huntId, playerId: player.id } },
    });

    const active = await prisma.spawn.findMany({
      where: {
        huntId,
        playerId: player.id,
        collectedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: "desc" },
    });

    const eligibility = evaluateSpawnEligibility({
      serverNow: now,
      playerActive: player.active && player.suspendedAt === null,
      huntActive: hunt.active,
      spawnEnabled: hunt.spawnEnabled,
      huntStartsAt: hunt.startsAt,
      huntEndsAt: hunt.endsAt,
      lastVerifiedLat: stats?.lastVerifiedLat ?? null,
      lastVerifiedLng: stats?.lastVerifiedLng ?? null,
      lastVerifiedAt: stats?.lastVerifiedAt ?? null,
      lastSpawnAt: stats?.lastSpawnAt ?? null,
      hasActiveSpawn: active.length > 0,
      spawnCooldownSeconds: hunt.spawnCooldownSeconds,
      spawnMinRadiusM: hunt.spawnMinRadiusM,
      spawnMaxRadiusM: hunt.spawnMaxRadiusM,
      spawnMinWei: toWei(hunt.spawnMinWei),
      spawnMaxWei: toWei(hunt.spawnMaxWei),
      maxVerifiedAgeSeconds: MAX_VERIFIED_FIX_AGE_SECONDS,
    });

    if (!eligibility.ok) {
      return NextResponse.json({
        spawned: false,
        reason: eligibility.reason,
        spawns: active.map(view),
      });
    }

    // Advisory, not the control: the binding budget check is the atomic
    // conditional UPDATE inside the collect transaction. This one only avoids
    // showing a player a spawn the hunt could never afford to pay.
    const budget = toWei(hunt.budgetMonWei);
    const spent = toWei(hunt.spentMonWei);
    const maxSpawn = toWei(hunt.spawnMaxWei);
    if (!(budget > 0n && spent + maxSpawn <= budget)) {
      return NextResponse.json({
        spawned: false,
        reason: "hunt_budget_exhausted",
        spawns: active.map(view),
      });
    }

    // The seed is HMAC(secret, spawnId): unguessable without the key, and
    // recomputable at reveal time without a column to store it in. No secret,
    // no spawn — failing loudly beats drawing money from a predictable source.
    const seedSecret = process.env.SPAWN_SEED_SECRET;
    if (!seedSecret) {
      console.error("[hunt/spawn] SPAWN_SEED_SECRET is not set");
      return NextResponse.json(
        { error: "spawns are not configured" },
        { status: 503 },
      );
    }

    const spawnId = `spn_${randomBytes(16).toString("hex")}`;
    const seed = deriveSeed(seedSecret, spawnId);
    const seedCommit = commitSeed(seed);

    // Walkable ground. `deriveSpawn` alone places a point on an abstract disc
    // and will happily drop one in the river or inside a house, then pay the
    // player for reaching it. These zones are what keep placement on streets.
    //
    // No INCLUDE zone means an unsurveyed hunt, which places nothing at all —
    // `isWalkable` treats an empty hull as "nowhere approved" rather than
    // "anywhere goes", so a half-finished survey fails safe.
    const zones = await prisma.zone.findMany({
      where: { huntId, active: true },
      select: { kind: true, vertices: true },
    });
    const area = {
      include: zones
        .filter((z) => z.kind === "INCLUDE")
        .map((z) => z.vertices as unknown as Ring),
      exclude: zones
        .filter((z) => z.kind === "EXCLUDE")
        .map((z) => z.vertices as unknown as Ring),
    };

    // An unsurveyed hunt places nothing unless it has opted in, and when it
    // has, it places CLOSE. The evidence is only ever "the player is standing
    // somewhere a human can stand", and that says much less about a point 600m
    // away than one 150m away — across a river, on a highway shoulder, inside
    // somebody's yard are all within 600m of a pavement. Shrinking the radius
    // is what keeps the weaker guarantee honest rather than merely weaker.
    const unsurveyed = area.include.length === 0 && area.exclude.length === 0;
    const allowUnsurveyed =
      unsurveyed && hunt.unsurveyedSpawnRadiusM > 0;
    const maxRadiusM = allowUnsurveyed
      ? Math.min(hunt.spawnMaxRadiusM, hunt.unsurveyedSpawnRadiusM)
      : hunt.spawnMaxRadiusM;
    const minRadiusM = Math.min(hunt.spawnMinRadiusM, maxRadiusM);

    const placement = deriveSpawnInArea(
      seed,
      {
        origin: eligibility.origin,
        minRadiusM,
        maxRadiusM,
        minWei: toWei(hunt.spawnMinWei),
        maxWei: toWei(hunt.spawnMaxWei),
      },
      area,
      10,
      allowUnsurveyed,
    );

    if (!placement.ok) {
      // Transient, not terminal: the player walking a hundred metres changes
      // the answer. The scan poll keeps running.
      console.warn(
        `[hunt/spawn] no walkable placement for player ${player.id} after ${placement.attempts} attempts`,
      );
      return NextResponse.json({
        spawned: false,
        reason: "no_walkable_ground",
        spawns: active.map(view),
      });
    }

    const draw = placement.draw;

    const expiresAt = new Date(now.getTime() + hunt.spawnTtlSeconds * 1000);

    // The cooldown, enforced by the database rather than by the check above.
    // The eligibility function read `lastSpawnAt`; two concurrent requests both
    // read the same value and both passed. This UPDATE is what makes exactly
    // one of them win.
    let created: Awaited<ReturnType<typeof prisma.spawn.create>> | null = null;
    try {
      created = await prisma.$transaction(async (tx) => {
        const claimed = await tx.$executeRaw`
          UPDATE "PlayerHunt"
             SET "lastSpawnAt" = ${now}
           WHERE "huntId" = ${huntId}
             AND "playerId" = ${player.id}
             AND ("lastSpawnAt" IS NULL
                  OR "lastSpawnAt" <= ${now}::timestamptz
                     - make_interval(secs => ${hunt.spawnCooldownSeconds}::int))`;
        if (claimed === 0) return null;

        // A second guard on the same race from the other side: no player may
        // hold two live spawns at once.
        const live = await tx.spawn.count({
          where: {
            huntId,
            playerId: player.id,
            collectedAt: null,
            expiresAt: { gt: now },
          },
        });
        if (live > 0) return null;

        return tx.spawn.create({
          data: {
            id: spawnId,
            huntId,
            playerId: player.id,
            lat: draw.lat,
            lng: draw.lng,
            amountMonWei: fromWei(draw.amountWei),
            seedCommit,
            expiresAt,
          },
        });
      });
    } catch (e) {
      console.error("[hunt/spawn] create failed", e);
      return NextResponse.json({ error: "internal error" }, { status: 500 });
    }

    if (!created) {
      return NextResponse.json({
        spawned: false,
        reason: "spawn_cooldown",
        spawns: active.map(view),
      });
    }

    return NextResponse.json({
      spawned: true,
      // Coordinates and amount are public by design; the seed is NOT, until
      // the spawn is collected or expires.
      spawns: [view(created), ...active.map(view)],
    });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: 401 });
    }
    console.error("[hunt/spawn]", e);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
