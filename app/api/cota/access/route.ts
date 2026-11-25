import { NextResponse } from "next/server";
import { AuthError, requirePlayer } from "@/lib/auth";
import { realMoneyAllowed } from "@/lib/cota/real-money";

// ---------------------------------------------------------------------------
// GET /api/cota/access — whether the signed-in hunter may use real-money Cota.
//
// The UI reads this to show "Real-money trading is closed for now." and to
// disable the buttons that would spend. It is a hint for the screen only: every
// money route checks the allowlist itself (lib/cota/real-money.ts), so a client
// that ignores this answer is still refused on the server.
//
// Signed out reads as closed. The answer is a single boolean about the caller;
// it never reveals who else is on the list.
// ---------------------------------------------------------------------------

export async function GET(req: Request) {
  try {
    const player = await requirePlayer(req);
    return NextResponse.json(
      { realMoney: realMoneyAllowed(player.walletAddress) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { realMoney: false },
        { headers: { "cache-control": "no-store" } },
      );
    }
    console.error("[cota/access] failed", err);
    return NextResponse.json({ realMoney: false }, { status: 500 });
  }
}
