import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, clientIp, requirePlayer } from "@/lib/auth";
import { checkLimit } from "@/lib/ratelimit";
import {
  MercadoError,
  placeQuote,
  start,
  sync,
  takeQuote,
  view,
} from "@/lib/mercado/service";

// ---------------------------------------------------------------------------
// /api/mercado — Haz Mercado, the quote-and-take game against the bot.
//
// GET brings the player's match up to now (settles closed minutes, runs out
// clocks, opens the next round) and returns it.
// POST makes a move: { action: "start" } | { action: "quote", bid, ask }
//      | { action: "take", side: "buy" | "sell" | "pass" }.
//
// The request carries intentions only. The reference price, the bot's moves
// and the settling close come from Perpl's public candles on the server
// (lib/mercado/service.ts). Points only: no venue key is read, no order sent.
// ---------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Input = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }).strict(),
  z
    .object({
      action: z.literal("quote"),
      bid: z.number().int().positive(),
      ask: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      action: z.literal("take"),
      side: z.enum(["buy", "sell", "pass"]),
    })
    .strict(),
]);

const STATUS: Record<MercadoError["code"], number> = {
  feed_unavailable: 503,
  busy: 409,
  refused: 422,
};

function fail(err: unknown, where: string) {
  if (err instanceof AuthError)
    return NextResponse.json({ error: "sign in first" }, { status: 401 });
  if (err instanceof MercadoError)
    return NextResponse.json(
      { error: err.code, reason: err.reason ?? null },
      { status: STATUS[err.code] },
    );
  console.error(`[mercado] ${where} failed`, err);
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
  const limit = await checkLimit("mercado", {
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

const noStore = { headers: { "cache-control": "no-store" } };

export async function GET(req: Request) {
  try {
    const { player, refused } = await gate(req);
    if (refused) return refused;
    return NextResponse.json(
      await view(player.id, await sync(player.id)),
      noStore,
    );
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
    const s =
      a.action === "start"
        ? await start(player.id)
        : a.action === "quote"
          ? await placeQuote(player.id, a.bid, a.ask)
          : await takeQuote(player.id, a.side);
    return NextResponse.json(await view(player.id, s), noStore);
  } catch (err) {
    return fail(err, "move");
  }
}
