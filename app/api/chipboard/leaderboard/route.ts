import { NextResponse } from "next/server";
import { AuthError, clientIp, requirePlayer } from "@/lib/auth";
import { checkLimit } from "@/lib/ratelimit";
import { prisma } from "@/lib/db/prisma";
import { httpBase } from "@/lib/chipboard/endpoints";

// ---------------------------------------------------------------------------
// GET /api/chipboard/leaderboard — today's Chip Board standings for the
// signed-in player.
//
// The Go server keeps the standings (keyed by player id); this route reads
// them and swaps ids for the public alias players opted into on the Cota
// leaderboard (CotasProfile.listed). Nobody else's id or wallet leaves this
// route: unlisted players are shown without a name, and the caller's own row
// is marked `me`. Points come from the server only; nothing is computed here.
// ---------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOP = 10;
const noStore = { "cache-control": "no-store" };

interface Standing {
  player: string;
  points: number;
  rounds: number;
  qualified: boolean;
  rank: number;
}
interface Board {
  day: string;
  players: number;
  qualifyRounds: number;
  standings: Standing[];
}

function isBoard(x: unknown): x is Board {
  const b = x as Board;
  return (
    !!b &&
    typeof b.day === "string" &&
    typeof b.players === "number" &&
    typeof b.qualifyRounds === "number" &&
    Array.isArray(b.standings)
  );
}

export async function GET(req: Request) {
  const base = httpBase();
  if (!base)
    return NextResponse.json(
      { error: "chipboard unavailable" },
      { status: 503, headers: noStore },
    );
  try {
    const player = await requirePlayer(req);
    const limit = await checkLimit("mercado", {
      playerId: player.id,
      ip: clientIp(req),
    });
    if (!limit.ok)
      return NextResponse.json(
        { error: "slow down" },
        { status: 429, headers: noStore },
      );

    let board: Board;
    try {
      const r = await fetch(`${base}/leaderboard?limit=1000`, {
        cache: "no-store",
        signal: AbortSignal.timeout(3_000),
      });
      const j: unknown = r.ok ? await r.json() : null;
      if (!isBoard(j)) throw new Error(`status ${r.status}`);
      board = j;
    } catch {
      return NextResponse.json(
        { error: "chipboard unavailable" },
        { status: 503, headers: noStore },
      );
    }

    const top = board.standings.slice(0, TOP);
    const mine = board.standings.find((s) => s.player === player.id) ?? null;
    const shown = mine && mine.rank > TOP ? [...top, mine] : top;
    const profiles = await prisma.cotasProfile.findMany({
      where: {
        playerId: { in: shown.map((s) => s.player) },
        listed: true,
      },
      select: { playerId: true, alias: true },
    });
    const alias = new Map(profiles.map((p) => [p.playerId, p.alias]));

    return NextResponse.json(
      {
        day: board.day,
        players: board.players,
        qualifyRounds: board.qualifyRounds,
        rows: shown.map((s) => ({
          rank: s.rank,
          alias: alias.get(s.player) ?? null,
          points: s.points,
          rounds: s.rounds,
          qualified: s.qualified,
          me: s.player === player.id,
        })),
        me: mine && {
          rank: mine.rank,
          points: mine.points,
          rounds: mine.rounds,
          qualified: mine.qualified,
        },
      },
      { headers: noStore },
    );
  } catch (err) {
    if (err instanceof AuthError)
      return NextResponse.json(
        { error: "sign in first" },
        { status: 401, headers: noStore },
      );
    console.error(
      "[chipboard/leaderboard] failed:",
      err instanceof Error ? err.message : "unknown",
    );
    return NextResponse.json(
      { error: "server error" },
      { status: 500, headers: noStore },
    );
  }
}
