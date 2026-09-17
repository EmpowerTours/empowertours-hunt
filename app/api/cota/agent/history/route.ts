import { NextResponse } from "next/server";
import { AuthError, requirePlayer } from "@/lib/auth";
import { prisma } from "@/lib/db/prisma";

// ---------------------------------------------------------------------------
// GET /api/cota/agent/history — what this hunter's agent has been doing.
//
// The hunter's session, not the agent token. A person reading their own agent's
// record is a different act from the agent writing it, and only one of them
// should be possible with a shared secret.
//
// Scoped to the caller by playerId at the query, never by a parameter. An
// endpoint that takes whose-history-to-show as input is an endpoint that shows
// somebody else's the first time a caller passes a different id.
// ---------------------------------------------------------------------------

const MAX = 100;

export async function GET(req: Request) {
  try {
    const player = await requirePlayer(req);
    const url = new URL(req.url);
    const digest = url.searchParams.get("digest");
    const limit = Math.min(
      MAX,
      Math.max(1, Number(url.searchParams.get("limit") ?? 30) || 30),
    );

    const rows = await prisma.cotaAgentDecision.findMany({
      where: {
        playerId: player.id,
        ...(digest ? { cotaDigest: digest } : {}),
      },
      orderBy: { at: "desc" },
      take: limit,
      select: {
        id: true,
        cotaDigest: true,
        act: true,
        why: true,
        dryRun: true,
        detail: true,
        at: true,
      },
    });

    return NextResponse.json({ decisions: rows });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    console.error("[cota/agent/history] failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}
