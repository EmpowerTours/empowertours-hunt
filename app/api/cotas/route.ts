import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, clientIp, requirePlayer } from "@/lib/auth";
import { checkLimit } from "@/lib/ratelimit";
import {
  CotasError,
  moveWalls,
  refill,
  sync,
  takeDown,
  view,
} from "@/lib/cotas/service";

// ---------------------------------------------------------------------------
// /api/cotas — the play-money wall game.
//
// GET  catches the player's game up with Perpl's real MON trades and returns it.
// POST changes it: { action: "walls", lo, hi, qty } | { action: "down" }
//      | { action: "refill" }.
//
// The request carries intentions only. Prices, fills and chips are computed on
// the server from Perpl's public candles (lib/cotas/service.ts); there is no
// field here that a client can use to name a price or a result.
//
// Behind the Hunt passkey session like every Cota route, and touching nothing
// but the Cotas tables: no venue key is read, no order is sent.
// ---------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Input = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("walls"),
    lo: z.number().int().positive(),
    hi: z.number().int().positive(),
    qty: z.number().int().positive(),
  }).strict(),
  z.object({ action: z.literal("down") }).strict(),
  z.object({ action: z.literal("refill") }).strict(),
]);

const STATUS: Record<CotasError["code"], number> = {
  feed_unavailable: 503,
  busy: 409,
  walls_refused: 422,
  holding: 409,
  no_refill: 409,
};

function fail(err: unknown, where: string) {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: "sign in first" }, { status: 401 });
  }
  if (err instanceof CotasError) {
    return NextResponse.json(
      { error: err.code, reason: err.reason ?? null },
      { status: STATUS[err.code] },
    );
  }
  console.error(`[cotas] ${where} failed`, err);
  return NextResponse.json({ error: "server error" }, { status: 500 });
}

async function gate(req: Request) {
  const player = await requirePlayer(req);
  if (!player.active || player.suspendedAt)
    return {
      player,
      refused: NextResponse.json(
        { error: "account inactive" },
        { status: 403 },
      ),
    };
  const limit = await checkLimit("cotas", {
    playerId: player.id,
    ip: clientIp(req),
  });
  if (!limit.ok)
    return {
      player,
      refused: NextResponse.json({ error: "slow down" }, { status: 429 }),
    };
  return { player, refused: null };
}

export async function GET(req: Request) {
  try {
    const { player, refused } = await gate(req);
    if (refused) return refused;
    const row = await sync(player.id);
    return NextResponse.json(await view(player.id, row), {
      headers: { "cache-control": "no-store" },
    });
  } catch (err) {
    return fail(err, "sync");
  }
}

export async function POST(req: Request) {
  try {
    const { player, refused } = await gate(req);
    if (refused) return refused;
    const parsed = Input.safeParse(await req.json().catch(() => null));
    if (!parsed.success)
      return NextResponse.json({ error: "bad request" }, { status: 400 });
    const a = parsed.data;
    const row =
      a.action === "walls"
        ? await moveWalls(player.id, { lo: a.lo, hi: a.hi }, a.qty)
        : a.action === "down"
          ? await takeDown(player.id)
          : await refill(player.id);
    return NextResponse.json(await view(player.id, row), {
      headers: { "cache-control": "no-store" },
    });
  } catch (err) {
    return fail(err, "action");
  }
}
