import { NextResponse } from "next/server";
import { type Address } from "viem";
import { prisma } from "@/lib/db/prisma";
import { AuthError, clientIp, requirePlayer } from "@/lib/auth";
import { checkLimit } from "@/lib/ratelimit";
import { relayerConfig, relayFreeLicense } from "@/lib/dime/relayer";

// ---------------------------------------------------------------------------
// POST /api/dime/claim — one free "Dime Que Sí" licence for the signed-in
// passkey wallet.
//
// ## The order that makes double-claiming impossible
//
// 1. Reserve: create the DimeClaim row FIRST. playerId is unique, so a second
//    claim — concurrent or later — hits the constraint and is turned away
//    before any chain work. The reservation is the lock.
// 2. Cap: count reservations; stop at DIME_MAX_CLAIMS.
// 3. Relay: buy and transfer. This is slow and can fail, which is exactly why
//    it happens AFTER the row exists — a failure updates the row rather than
//    leaving a gap a retry could slip through.
//
// A relay failure marks the row FAILED and frees nothing automatically: a hot
// wallet that bought but could not transfer holds a real licence, and that is a
// human's to resolve, not a loop's to retry into a second purchase.
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CLAIMS = 2000;

function maxClaims(): number {
  const raw = process.env.DIME_MAX_CLAIMS;
  const n = raw ? Number(raw) : DEFAULT_MAX_CLAIMS;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_CLAIMS;
}

export async function POST(req: Request) {
  try {
    const cfg = relayerConfig();
    if (cfg === null) {
      return NextResponse.json(
        { error: "the drop is not open right now" },
        { status: 503 },
      );
    }

    const player = await requirePlayer(req);

    // Same money-path bucket as claims: a signature ceremony gates each call,
    // so this bounds a script hammering the endpoint, not a person.
    const limit = await checkLimit("claim", {
      playerId: player.id,
      ip: clientIp(req),
    });
    if (!limit.ok) {
      return NextResponse.json({ error: "slow down" }, { status: 429 });
    }

    // If this player already has a row, the claim is done or in flight. Report
    // its state rather than trying again — a second relay is a second licence.
    const existing = await prisma.dimeClaim.findUnique({
      where: { playerId: player.id },
      select: { status: true, transferTxHash: true, licenseId: true },
    });
    if (existing) {
      if (existing.status === "SENT") {
        return NextResponse.json({
          ok: true,
          alreadyClaimed: true,
          licenseId: existing.licenseId,
          transferTxHash: existing.transferTxHash,
        });
      }
      if (existing.status === "PENDING") {
        return NextResponse.json(
          { error: "your claim is already being sent" },
          { status: 409 },
        );
      }
      // FAILED: allow one more attempt below by reusing the row.
    }

    // Reserve. The unique constraint on playerId is the concurrency guard: two
    // simultaneous first-claims race here and exactly one creates the row.
    let reserved;
    try {
      reserved = existing
        ? await prisma.dimeClaim.update({
            where: { playerId: player.id },
            data: {
              status: "PENDING",
              walletAddress: player.walletAddress,
              failReason: null,
            },
            select: { id: true },
          })
        : await prisma.dimeClaim.create({
            data: {
              playerId: player.id,
              walletAddress: player.walletAddress,
              status: "PENDING",
            },
            select: { id: true },
          });
    } catch (err) {
      if (
        typeof err === "object" &&
        err !== null &&
        (err as { code?: string }).code === "P2002"
      ) {
        return NextResponse.json(
          { error: "your claim is already being sent" },
          { status: 409 },
        );
      }
      throw err;
    }

    // The cap counts reservations INCLUDING this one. A claim that pushes past
    // the ceiling is rolled back to FAILED so the count is honest and the
    // player is told the drop is out rather than left PENDING forever.
    const claimed = await prisma.dimeClaim.count({
      where: { status: { in: ["PENDING", "SENT"] } },
    });
    if (claimed > maxClaims()) {
      await prisma.dimeClaim.update({
        where: { id: reserved.id },
        data: { status: "FAILED", failReason: "sold_out" },
      });
      return NextResponse.json(
        {
          error: "every free claim is gone. Collector editions are still open.",
        },
        { status: 409 },
      );
    }

    const result = await relayFreeLicense(cfg, player.walletAddress as Address);

    if (!result.ok) {
      await prisma.dimeClaim.update({
        where: { id: reserved.id },
        data: {
          status: "FAILED",
          failReason: result.error ?? "relay failed",
          purchaseTxHash: result.purchaseTxHash ?? null,
          licenseId: result.licenseId ?? null,
        },
      });
      return NextResponse.json(
        { error: "the claim could not be sent. Try again in a moment." },
        { status: 502 },
      );
    }

    await prisma.dimeClaim.update({
      where: { id: reserved.id },
      data: {
        status: "SENT",
        licenseId: result.licenseId ?? null,
        purchaseTxHash: result.purchaseTxHash ?? null,
        transferTxHash: result.transferTxHash ?? null,
      },
    });

    return NextResponse.json({
      ok: true,
      licenseId: result.licenseId,
      transferTxHash: result.transferTxHash,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    console.error("[dime/claim] failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    const cfg = relayerConfig();
    const open = cfg !== null;

    const claimed = await prisma.dimeClaim.count({
      where: { status: { in: ["PENDING", "SENT"] } },
    });
    const remaining = Math.max(0, maxClaims() - claimed);

    let mine: { status: string; transferTxHash: string | null } | null = null;
    try {
      const player = await requirePlayer(req);
      const row = await prisma.dimeClaim.findUnique({
        where: { playerId: player.id },
        select: { status: true, transferTxHash: true },
      });
      mine = row;
    } catch (err) {
      if (!(err instanceof AuthError)) throw err;
    }

    return NextResponse.json({ open, remaining, mine });
  } catch (err) {
    console.error("[dime/claim] GET failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}
