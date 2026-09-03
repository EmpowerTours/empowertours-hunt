import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { AuthError, clientIp, requirePlayer } from "@/lib/auth";
import { checkLimit } from "@/lib/ratelimit";
import {
  PUBLIC_HUNT_SELECT,
  isListable,
  remainingFinds,
  toPublicHunt,
} from "@/lib/hunt/publicHunt";
import { mayCreateHunt } from "@/lib/hunt/sembrador";

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

const CreateHunt = z.object({
  name: z.string().trim().min(3).max(80),
  description: z.string().trim().max(500).optional(),
});

/**
 * POST /api/hunts — a Sembrador opens a hunt in their own city.
 *
 * ## It starts inactive, and pays nothing
 *
 * `active` defaults to false and both budgets default to 0, so a newly planted
 * hunt is invisible to the list and cannot pay anybody. That is deliberate for
 * the MVP: opening creation is a much smaller decision when the thing being
 * created cannot spend money. Funding is a separate act with its own gate.
 *
 * ## The hunt cap is advisory, and this comment is why
 *
 * Counting then creating is a read-then-write, so two simultaneous requests
 * can both see two hunts and both create a third. Unlike the credit and spawn
 * ceilings — which are conditional UPDATEs precisely because losing that race
 * loses money — the worst case here is a Sembrador with four hunts instead of
 * three. Abuse limit, not a money limit. Do not copy this shape to anything
 * that spends.
 */
export async function POST(req: Request) {
  try {
    const player = await requirePlayer(req);

    const limit = await checkLimit("cota", {
      playerId: player.id,
      ip: clientIp(req),
    });
    if (!limit.ok) {
      return NextResponse.json({ error: "slow down" }, { status: 429 });
    }

    const parsed = CreateHunt.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "bad request" }, { status: 400 });
    }

    const open = await prisma.hunt.count({
      where: { createdByPlayerId: player.id, active: true },
    });
    const allowed = mayCreateHunt(open);
    if (!allowed.ok) {
      return NextResponse.json({ error: allowed.reason }, { status: 409 });
    }

    const hunt = await prisma.hunt.create({
      data: {
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        createdByPlayerId: player.id,
        // Explicit, not inherited from the schema default, because these two
        // are the whole safety argument for opening creation up.
        active: false,
        spawnEnabled: false,
      },
      select: { id: true, name: true, active: true, createdAt: true },
    });

    return NextResponse.json({ ok: true, hunt }, { status: 201 });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    console.error("[hunts] POST failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}
