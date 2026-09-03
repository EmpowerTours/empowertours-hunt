import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { AuthError, clientIp, requirePlayer } from "@/lib/auth";
import { verifyCotaSignature } from "@/lib/auth/eip712";
import { checkLimit } from "@/lib/ratelimit";
import { cotaDigest, isCotaVenue } from "@/lib/cota/typedData";

// ---------------------------------------------------------------------------
// Storing a signed Cota.
//
//   POST  sign   — verify an EIP-712 Cota signature, record the bound
//   GET   list   — the caller's own bounds, newest first
//
// ## The server verifies what it was GIVEN, never what it can re-derive
//
// The body carries both the message and the signature, and verification runs
// against the message as sent. It would be easy — and wrong — to rebuild the
// message from a few fields and check the signature against that: the moment
// the server chooses any part of what was signed, the signature stops being
// evidence of what the player agreed to and becomes evidence that the server
// agrees with itself.
//
// ## Ceilings are stored as the scaled integers that were signed
//
// Not as decimals. The stored row has to re-verify from itself later (see the
// `digest` column), and a value that has been through a float cannot.
// ---------------------------------------------------------------------------

/** Scaled uint256 as a decimal string — never a JS number. */
const scaled = z.string().regex(/^\d{1,78}$/);

const CotaInput = z.object({
  venue: z.string().min(1).max(32),
  markets: z.array(z.string().min(1).max(32)).max(32),
  maxNotionalUsdE6: scaled,
  maxLeverageX100: scaled,
  maxDailyLossUsdE6: scaled,
  maxTradesPerDay: z.number().int().min(0).max(4_294_967_295),
  notBefore: scaled,
  notAfter: scaled,
  clientTs: scaled,
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130,}$/),
});

function secondsToDate(v: string): Date {
  return new Date(Number(v) * 1000);
}

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

    const parsed = CotaInput.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "bad request" }, { status: 400 });
    }
    const input = parsed.data;

    // A venue this build does not know about cannot be enforced, and a bound
    // nothing enforces is worse than no bound: the player believes they are
    // covered. Refuse it at the door rather than store it.
    if (!isCotaVenue(input.venue)) {
      return NextResponse.json({ error: "unknown venue" }, { status: 400 });
    }

    // notBefore after notAfter is a window that never opens. It would verify
    // and store perfectly happily, then deny every order with "not_yet_valid"
    // — a bound that silently authorises nothing while looking live.
    if (BigInt(input.notBefore) > BigInt(input.notAfter)) {
      return NextResponse.json(
        { error: "notBefore is after notAfter" },
        { status: 400 },
      );
    }

    // Built once and used for BOTH verification and the digest, so the row is
    // keyed by the same bytes the signature was checked against. Two separate
    // constructions could drift and key a row by an agreement nobody signed.
    const message = {
      venue: input.venue,
      markets: input.markets,
      maxNotionalUsdE6: BigInt(input.maxNotionalUsdE6),
      maxLeverageX100: BigInt(input.maxLeverageX100),
      maxDailyLossUsdE6: BigInt(input.maxDailyLossUsdE6),
      maxTradesPerDay: input.maxTradesPerDay,
      notBefore: BigInt(input.notBefore),
      notAfter: BigInt(input.notAfter),
      clientTs: BigInt(input.clientTs),
      nonce: input.nonce,
    };

    const verified = await verifyCotaSignature({
      ...message,
      signature: input.signature as `0x${string}`,
      expectedAddress: player.walletAddress,
    });

    if (!verified.ok) {
      // The reason is returned because every one of them is something the
      // player can act on — re-sign, wait, check the clock — and a bare 401
      // on the screen where somebody just used Face ID reads as a broken app.
      return NextResponse.json({ error: verified.reason }, { status: 400 });
    }

    const row = await prisma.cota.create({
      data: {
        playerId: player.id,
        venue: input.venue,
        markets: input.markets,
        maxNotionalUsdE6: input.maxNotionalUsdE6,
        maxLeverageX100: input.maxLeverageX100,
        maxDailyLossUsdE6: input.maxDailyLossUsdE6,
        maxTradesPerDay: input.maxTradesPerDay,
        notBefore: secondsToDate(input.notBefore),
        notAfter: secondsToDate(input.notAfter),
        clientTs: secondsToDate(input.clientTs),
        nonce: input.nonce,
        signature: input.signature,
        digest: cotaDigest(message),
      },
      select: { id: true, digest: true, createdAt: true },
    });

    return NextResponse.json({ ok: true, cota: row }, { status: 201 });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    // A duplicate digest means this exact bound is already on file. That is
    // not an error worth alarming anybody with: the same agreement signed
    // twice is the same agreement.
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "P2002"
    ) {
      return NextResponse.json({ error: "already signed" }, { status: 409 });
    }
    console.error("[cota] POST failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    const player = await requirePlayer(req);
    const rows = await prisma.cota.findMany({
      where: { playerId: player.id },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        venue: true,
        markets: true,
        maxNotionalUsdE6: true,
        maxLeverageX100: true,
        maxDailyLossUsdE6: true,
        maxTradesPerDay: true,
        notBefore: true,
        notAfter: true,
        digest: true,
        revokedAt: true,
        anchorTxHash: true,
        createdAt: true,
      },
    });

    // Decimal columns do not survive JSON as numbers without losing precision,
    // so they leave as strings — the same form they arrived in and the same
    // form the signature covers.
    return NextResponse.json({
      cotas: rows.map((r: (typeof rows)[number]) => ({
        ...r,
        maxNotionalUsdE6: r.maxNotionalUsdE6.toFixed(0),
        maxLeverageX100: r.maxLeverageX100.toFixed(0),
        maxDailyLossUsdE6: r.maxDailyLossUsdE6.toFixed(0),
      })),
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    console.error("[cota] GET failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}
