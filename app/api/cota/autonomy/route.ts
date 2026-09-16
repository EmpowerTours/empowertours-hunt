import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requirePlayer } from "@/lib/auth";
import { prisma } from "@/lib/db/prisma";
import { AUTONOMY_MODES, verifyStoredGrant } from "@/lib/cota/autonomy";
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
  /** Required for a grant, forbidden for "off" — see the note on withdrawal. */
  signature: z
    .string()
    .regex(/^0x[0-9a-fA-F]{130,}$/)
    .optional(),
  nonce: z.string().min(8).max(128).optional(),
  /** Unix SECONDS. The grant's own expiry, inside the signature. */
  notAfter: z.number().int().positive().optional(),
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
      if (
        !parsed.data.signature ||
        !parsed.data.nonce ||
        !parsed.data.notAfter
      ) {
        return NextResponse.json(
          { error: "a grant must be signed: signature, nonce and notAfter" },
          { status: 400 },
        );
      }
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

      // Verify with the SAME function the read path uses. Two verifiers would
      // be two things to keep in step, and the one that matters is the reader —
      // a grant that stores cleanly and fails on read is a grant that silently
      // never works.
      const check = await verifyStoredGrant({
        stored: mode,
        cotaDigest: digest,
        signature: parsed.data.signature,
        nonce: parsed.data.nonce,
        notAfter: new Date(parsed.data.notAfter * 1000),
        walletAddress: player.walletAddress,
      });
      if (check.mode === "off") {
        return NextResponse.json(
          { error: `signature rejected: ${check.reason ?? "invalid"}` },
          { status: 400 },
        );
      }
    }

    const updated = await prisma.cota.update({
      where: { id: cota.id },
      data:
        mode === "off"
          ? {
              autonomy: null,
              autonomyAt: null,
              autonomySignature: null,
              autonomyNonce: null,
              autonomyNotAfter: null,
            }
          : {
              autonomy: mode,
              autonomyAt: new Date(),
              autonomySignature: parsed.data.signature,
              autonomyNonce: parsed.data.nonce,
              autonomyNotAfter: new Date(parsed.data.notAfter! * 1000),
            },
      select: {
        digest: true,
        autonomy: true,
        autonomyAt: true,
        autonomySignature: true,
        autonomyNonce: true,
        autonomyNotAfter: true,
      },
    });

    // Report what a READER would see, not what was written. If those ever
    // disagree the hunter should find out now, not when the agent quietly
    // declines to act.
    const asRead = await verifyStoredGrant({
      stored: updated.autonomy,
      cotaDigest: updated.digest,
      signature: updated.autonomySignature,
      nonce: updated.autonomyNonce,
      notAfter: updated.autonomyNotAfter,
      walletAddress: player.walletAddress,
    });

    return NextResponse.json({
      digest: updated.digest,
      mode: asRead.mode,
      since: updated.autonomyAt,
      notAfter: updated.autonomyNotAfter,
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
      select: {
        digest: true,
        autonomy: true,
        autonomyAt: true,
        autonomySignature: true,
        autonomyNonce: true,
        autonomyNotAfter: true,
      },
    });
    if (!cota) {
      return NextResponse.json({ error: "no such leash" }, { status: 404 });
    }
    const asRead = await verifyStoredGrant({
      stored: cota.autonomy,
      cotaDigest: cota.digest,
      signature: cota.autonomySignature,
      nonce: cota.autonomyNonce,
      notAfter: cota.autonomyNotAfter,
      walletAddress: player.walletAddress,
    });
    return NextResponse.json({
      digest: cota.digest,
      mode: asRead.mode,
      since: cota.autonomyAt,
      notAfter: cota.autonomyNotAfter,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    console.error("[cota/autonomy] read failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}
