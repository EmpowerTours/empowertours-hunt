import { NextResponse } from "next/server";
import { AuthError, clientIp, requirePlayer } from "@/lib/auth";
import { checkLimit } from "@/lib/ratelimit";
import { mintToken, sessionSecret, TOKEN_TTL_S } from "@/lib/chipboard/token";
import { wsUrl } from "@/lib/chipboard/endpoints";

// ---------------------------------------------------------------------------
// POST /api/chipboard/token — a short-lived session token for the Chip Board
// game server (services/chipboard), keyed by the signed-in player's id.
//
// The browser sends it as the first WebSocket message; the Go server checks
// the HMAC with the same CHIPBOARD_SESSION_SECRET. Neither the secret nor the
// token is ever logged. Without a usable secret or WS URL this fails closed
// (503) rather than handing out something the server will refuse.
//
// POST, not GET: the response is a credential and must never be cached or
// prefetched. It shares the "mercado" limit with Cota Práctica (same game
// surface, fails open; a token is useless without a valid session anyway).
// ---------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };

export async function POST(req: Request) {
  const secret = sessionSecret();
  const url = wsUrl();
  if (!secret || !url)
    return NextResponse.json(
      { error: "chipboard unavailable" },
      { status: 503, headers: noStore },
    );
  try {
    const player = await requirePlayer(req);
    if (!player.active || player.suspendedAt)
      return NextResponse.json(
        { error: "account inactive" },
        { status: 403, headers: noStore },
      );
    const limit = await checkLimit("mercado", {
      playerId: player.id,
      ip: clientIp(req),
    });
    if (!limit.ok)
      return NextResponse.json(
        { error: "slow down" },
        { status: 429, headers: noStore },
      );
    const expiry = Math.floor(Date.now() / 1000) + TOKEN_TTL_S;
    return NextResponse.json(
      { token: mintToken(player.id, expiry, secret), wsUrl: url, expiry },
      { headers: noStore },
    );
  } catch (err) {
    if (err instanceof AuthError)
      return NextResponse.json(
        { error: "sign in first" },
        { status: 401, headers: noStore },
      );
    // The message only: an error object here could carry the request.
    console.error(
      "[chipboard/token] failed:",
      err instanceof Error ? err.name : "unknown",
    );
    return NextResponse.json(
      { error: "server error" },
      { status: 500, headers: noStore },
    );
  }
}
