import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { AuthError, clientIp, requirePlayer } from "@/lib/auth";
import { SESSION_STATEMENT } from "@/lib/auth/eip712";
import {
  clearSessionCookieHeader,
  issueSession,
  sessionCookieHeader,
  verifyMeraLogin,
} from "@/lib/auth/mera";
import { checkLimit } from "@/lib/ratelimit";

// ---------------------------------------------------------------------------
// Session lifecycle for the mera (passkey) provider.
//
//   POST   log in  — verify an EIP-712 Session signature, mint an HttpOnly cookie
//   GET    whoami  — who the current cookie resolves to
//   DELETE log out — clear the cookie
//
// mera derives an ordinary secp256k1 key from a passkey's PRF output in the
// BROWSER; there is no mera server SDK. So logging in is signature verification,
// which is why this route needs no mera dependency and cannot be broken by a
// change to mera's preview API.
// ---------------------------------------------------------------------------

const LoginInput = z.object({
  wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  statement: z.literal(SESSION_STATEMENT),
  clientTs: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130,}$/),
  passkeyCredentialId: z.string().min(1).max(256).optional(),
});

export async function POST(req: Request) {
  try {
    const ip = clientIp(req);
    // Keyed on IP only: there is no authenticated identity yet, which is the
    // point of the endpoint.
    const limit = await checkLimit("register", { ip });
    if (!limit.ok) {
      return NextResponse.json(
        { error: "slow down" },
        { status: 429, headers: { "retry-after": retryAfter(limit.resetAt) } },
      );
    }

    const input = LoginInput.parse(await req.json());

    const verified = await verifyMeraLogin({
      wallet: input.wallet,
      statement: input.statement,
      clientTs: BigInt(input.clientTs),
      nonce: input.nonce,
      signature: input.signature as `0x${string}`,
    });
    // One opaque message for every failure mode. Telling a caller whether the
    // nonce or the signature was the problem tells them which half to iterate
    // on, and this endpoint is unauthenticated.
    if (!verified.ok) {
      return NextResponse.json({ error: "invalid signature" }, { status: 401 });
    }

    // Signing in does NOT create a Player. Registration is a separate, explicit
    // act — an implicit create here would reintroduce exactly the mid-hunt
    // self-enrolment that app/api/register exists to keep bounded and logged.
    const player = await prisma.player.findUnique({
      where: { walletAddress: verified.address },
      select: { id: true, active: true, suspendedAt: true },
    });
    if (!player) {
      return NextResponse.json(
        { error: "not registered for the hunt" },
        { status: 404 },
      );
    }

    let token: string;
    try {
      token = issueSession(verified.address, input.passkeyCredentialId ?? null);
    } catch {
      // AUTH_SESSION_SECRET missing or too short. Fails closed: no cookie is
      // minted, and the operator sees a 500 rather than a silently weak session.
      console.error("[auth/session] AUTH_SESSION_SECRET is not configured");
      return NextResponse.json({ error: "internal error" }, { status: 500 });
    }

    return NextResponse.json(
      {
        authenticated: true,
        player: {
          id: player.id,
          walletAddress: verified.address,
          active: player.active,
          suspended: player.suspendedAt !== null,
        },
      },
      { headers: { "set-cookie": sessionCookieHeader(token) } },
    );
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: "invalid payload" }, { status: 400 });
    }
    if (e instanceof SyntaxError) {
      return NextResponse.json({ error: "invalid payload" }, { status: 400 });
    }
    console.error("[auth/session] POST failed");
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    const player = await requirePlayer(req);
    return NextResponse.json(
      {
        authenticated: true,
        player: {
          id: player.id,
          walletAddress: player.walletAddress,
          active: player.active,
          suspended: player.suspendedAt !== null,
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json(
        { authenticated: false },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
    }
    console.error("[auth/session] GET failed");
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}

export function DELETE() {
  // Unconditional: logging out must work even when the cookie is already
  // invalid, and it reveals nothing.
  return NextResponse.json(
    { authenticated: false },
    { headers: { "set-cookie": clearSessionCookieHeader() } },
  );
}

function retryAfter(resetAt: number): string {
  return String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)));
}
