import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, clientIp, requirePlayer } from "@/lib/auth";
import { checkLimit } from "@/lib/ratelimit";
import {
  getProfile,
  myWeek,
  setProfile,
  validAlias,
  weeklyBoard,
} from "@/lib/mercado/board";

// ---------------------------------------------------------------------------
// /api/mercado/tabla
//
// GET is public: aliases, points per match and counts for players who opted
// in. No wallet and no player id leaves this route.
//
// With a session it also returns the caller's own week (listed or not) and
// their profile. POST sets the alias and whether to be listed.
// ---------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const limit = await checkLimit("browse", { ip: clientIp(req) });
    if (!limit.ok)
      return NextResponse.json({ error: "slow down" }, { status: 429 });

    const { weekStart, board } = await weeklyBoard();
    let me = null;
    let profile = null;
    try {
      const player = await requirePlayer(req);
      [me, profile] = await Promise.all([
        myWeek(player.id),
        getProfile(player.id),
      ]);
    } catch (err) {
      if (!(err instanceof AuthError)) throw err;
    }
    return NextResponse.json({
      weekStart,
      board: board.slice(0, 100).map((r) => ({
        rank: r.rank,
        alias: r.alias,
        avg: r.avg,
        matches: r.matches,
        wins: r.wins,
        mine: me !== null && r.playerId === me.playerId,
      })),
      me: me && {
        avg: me.avg,
        matches: me.matches,
        wins: me.wins,
        qualifies: me.qualifies,
      },
      profile,
    });
  } catch (err) {
    console.error("[mercado/tabla] read failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}

const Input = z.object({ alias: z.unknown(), listed: z.boolean() });

export async function POST(req: Request) {
  try {
    const player = await requirePlayer(req);
    const limit = await checkLimit("mercado", {
      playerId: player.id,
      ip: clientIp(req),
    });
    if (!limit.ok)
      return NextResponse.json({ error: "slow down" }, { status: 429 });
    const parsed = Input.safeParse(await req.json().catch(() => null));
    if (!parsed.success || !validAlias(parsed.data.alias)) {
      return NextResponse.json(
        { error: "alias must be 3-16 letters, digits or _" },
        { status: 400 },
      );
    }
    const r = await setProfile(
      player.id,
      parsed.data.alias,
      parsed.data.listed,
    );
    if (r === "taken")
      return NextResponse.json({ error: "alias taken" }, { status: 409 });
    return NextResponse.json({
      alias: parsed.data.alias,
      listed: parsed.data.listed,
    });
  } catch (err) {
    if (err instanceof AuthError)
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    console.error("[mercado/tabla] profile failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}
