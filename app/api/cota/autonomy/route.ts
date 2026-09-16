import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requirePlayer } from "@/lib/auth";
import { prisma } from "@/lib/db/prisma";
import { AUTONOMY_MODES, parseAutonomy } from "@/lib/cota/autonomy";
import { governsLiveOrders } from "@/lib/cota/active-leash";

// ---------------------------------------------------------------------------
// POST /api/cota/autonomy — grant or withdraw the agent's permission to act on
// one leash with nobody watching. GET — what the current grant is.
//
// Requires the hunter's session. That is the whole point of the route: it is the
// only moment a person says "act without me", so it must be a person saying it.
// Nothing else in the system may set this — not the agent token, not an admin
// path, not a default.
//
// Scoped to a DIGEST, never to a player. Two properties follow:
//   - revoking the leash revokes autonomy with it, with no second switch to
//     forget;
//   - signing a larger leash requires consenting again, instead of the agent
//     inheriting permission for a ceiling nobody agreed to run unattended.
//
// Withdrawing is always allowed and never validated against anything. A hunter
// turning the agent off must never be refused for a reason — not an expired
// leash, not a revoked one, not a market we no longer support. "Off" is the one
// instruction that has to work under every condition.
// ---------------------------------------------------------------------------

const Input = z.object({
  digest: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  mode: z.enum(AUTONOMY_MODES),
});

export async function POST(req: Request) {
  try {
    const player = await requirePlayer(req);
    const parsed = Input.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: "bad request" }, { status: 400 });
    }
    const { digest, mode } = parsed.data;

    const cota = await prisma.cota.findFirst({
      where: { digest, playerId: player.id },
      select: {
        id: true,
        revokedAt: true,
        anchorTxHash: true,
        markets: true,
        notAfter: true,
      },
    });
    if (!cota) {
      return NextResponse.json({ error: "no such leash" }, { status: 404 });
    }

    // Turning it OFF short-circuits every check below.
    if (mode !== "off") {
      if (!governsLiveOrders(cota)) {
        return NextResponse.json(
          {
            error:
              "this leash does not govern live orders — it is revoked, unanchored (practice), or names no market this executor can trade",
          },
          { status: 409 },
        );
      }
      if (cota.notAfter.getTime() <= Date.now()) {
        return NextResponse.json(
          { error: "this leash has expired" },
          { status: 409 },
        );
      }
    }

    const updated = await prisma.cota.update({
      where: { id: cota.id },
      data: {
        autonomy: mode === "off" ? null : mode,
        autonomyAt: mode === "off" ? null : new Date(),
      },
      select: { digest: true, autonomy: true, autonomyAt: true },
    });

    return NextResponse.json({
      digest: updated.digest,
      mode: parseAutonomy(updated.autonomy),
      since: updated.autonomyAt,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    console.error("[cota/autonomy] failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    const player = await requirePlayer(req);
    const digest = new URL(req.url).searchParams.get("digest");
    if (!digest) {
      return NextResponse.json({ error: "digest required" }, { status: 400 });
    }
    const cota = await prisma.cota.findFirst({
      where: { digest, playerId: player.id },
      select: { digest: true, autonomy: true, autonomyAt: true },
    });
    if (!cota) {
      return NextResponse.json({ error: "no such leash" }, { status: 404 });
    }
    return NextResponse.json({
      digest: cota.digest,
      mode: parseAutonomy(cota.autonomy),
      since: cota.autonomyAt,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    console.error("[cota/autonomy] read failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}
