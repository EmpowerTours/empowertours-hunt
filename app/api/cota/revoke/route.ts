import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, clientIp, requirePlayer } from "@/lib/auth";
import { prisma } from "@/lib/db/prisma";
import { checkLimit } from "@/lib/ratelimit";
import { postOnlyResponse } from "@/lib/cota/post-only";

// ---------------------------------------------------------------------------
// POST /api/cota/revoke — withdraw a leash.
//
// This route exists because the promise was already being made and nothing kept
// it. `enforce.ts` refuses a bound whose `revokedAt` is set, the readback tells
// the hunter in both languages that they can revoke at any time, and every
// query that selects a live Cota filters on `revokedAt: null` — but NOTHING in
// the codebase ever wrote that column. Consent could be given and not taken
// back, so a runaway client or a stolen session kept its authority until
// `notAfter` came around on its own.
//
// What revoking does: stops anything NEW from opening. `mayOpen` returns
// "revoked" on the next attempt, and the trade route's own lookup stops finding
// the leash at all.
//
// What it deliberately does NOT do is touch the enrolled trading key. The
// hunter still needs it to read positions and to reconcile, and an open
// position is theirs to decide about — closing one to tidy up the authorisation
// would be making that decision for them, at whatever price the market happens
// to offer. The readback says as much: "what to do with an open position stays
// your call." Revoking the key as well is a separate, louder action.
//
// Idempotent on purpose. Revoking something already revoked is the outcome the
// caller wanted, so it answers 200 with the original timestamp rather than an
// error — a hunter double-tapping "revoke" must never see a failure.
// ---------------------------------------------------------------------------

const Input = z.object({
  /** The Cota to revoke. Required: revoking must never guess which one. */
  digest: z.string().min(1),
});

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

    const parsed = Input.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "bad request" }, { status: 400 });
    }
    const { digest } = parsed.data;

    // Scoped by playerId as well as digest: a digest is not a secret, and one
    // player must never be able to revoke another's leash.
    const cota = await prisma.cota.findFirst({
      where: { digest, playerId: player.id },
      select: { id: true, revokedAt: true },
    });
    if (!cota) {
      return NextResponse.json({ error: "no such Cota" }, { status: 404 });
    }

    if (cota.revokedAt) {
      return NextResponse.json({
        revoked: true,
        revokedAt: cota.revokedAt.toISOString(),
        alreadyRevoked: true,
      });
    }

    const revokedAt = new Date();
    await prisma.cota.update({
      where: { id: cota.id },
      data: { revokedAt },
    });

    console.log(
      "[cota/revoke] revoked:",
      JSON.stringify({ playerId: player.id, digest, at: revokedAt }),
    );

    return NextResponse.json({
      revoked: true,
      revokedAt: revokedAt.toISOString(),
      alreadyRevoked: false,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    console.error("[cota/revoke] failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}

/**
 * Withdrawing consent is a decision, and a GET is never one. Say where it is.
 */
export function GET(): NextResponse {
  return postOnlyResponse(
    "/api/cota/revoke",
    "Revoke a leash from /cota/trade — it stops anything new from opening and leaves any open position to you.",
  );
}
