import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { clientIp } from "@/lib/auth";
import { verifyRegistrationSignature } from "@/lib/auth/eip712";
import { issueSession, sessionCookieHeader } from "@/lib/auth/mera";
import { checkLimit } from "@/lib/ratelimit";

// ---------------------------------------------------------------------------
// Open registration.
//
// Anyone may self-register. There is no whitelist and Player.active starts
// true, so `active` is a moderation flag an admin flips to false, not a gate an
// admin flips to true.
//
// Open signup is only safe because the abuse is bounded elsewhere, so be clear
// about what does what:
//
//   * A SIGNATURE is required, so a caller can only register a wallet they hold.
//     Without it anyone could squat an address, and squatting an address that
//     later matters (a TURBO cohort member's) would be free.
//   * The RATE LIMIT is flood protection. It is NOT the sybil bound — a
//     determined attacker can make wallets faster than we can rate limit them.
//   * The SYBIL BOUND is economic and lives in the schema: Hunt.budgetCreditWei,
//     Hunt.budgetMonWei, Hunt.maxFindsPerPlayer, Hunt.spawnDailyCapWeiPerPlayer.
//     Ten thousand fake players cannot extract more than one hunt's budget.
//
// And the thing this route exists to keep true: a Player is created HERE and
// nowhere else. A claim handler that auto-creates on first sight would let a
// wallet enrol itself mid-hunt, after seeing where the value is.
// ---------------------------------------------------------------------------

const TURBO_USERNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-_]{0,37}[A-Za-z0-9])?$/;

const RegisterInput = z.object({
  wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  // Both optional fields are inside the signature (see REGISTRATION_TYPES), so
  // they are sent as "" when unused rather than omitted — the signed message
  // and the request body have to agree byte for byte.
  turboUsername: z.string().max(39).regex(TURBO_USERNAME_RE).or(z.literal("")),
  passkeyCredentialId: z.string().max(256),
  clientTs: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130,}$/),
  displayName: z.string().max(64).optional(),
});

export async function POST(req: Request) {
  try {
    const ip = clientIp(req);
    const limit = await checkLimit("register", { ip });
    if (!limit.ok) {
      return NextResponse.json(
        { error: "slow down" },
        {
          status: 429,
          headers: {
            "retry-after": String(
              Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 1000)),
            ),
          },
        },
      );
    }

    const input = RegisterInput.parse(await req.json());

    const verified = await verifyRegistrationSignature({
      wallet: input.wallet,
      turboUsername: input.turboUsername,
      passkeyCredentialId: input.passkeyCredentialId,
      clientTs: BigInt(input.clientTs),
      nonce: input.nonce,
      signature: input.signature as `0x${string}`,
    });
    if (!verified.ok) {
      return NextResponse.json({ error: "invalid signature" }, { status: 401 });
    }

    // Lowercased. Player.walletAddress is stored lowercased and looked up
    // lowercased; a checksummed row here would create an account that auth can
    // never find, which reads to the player as "my registration vanished".
    const walletAddress = verified.address;
    const credentialId =
      input.passkeyCredentialId.length > 0 ? input.passkeyCredentialId : null;

    const existing = await prisma.player.findUnique({
      where: { walletAddress },
      select: { id: true, active: true, suspendedAt: true },
    });

    let playerId: string;
    let active: boolean;
    let suspended: boolean;

    if (existing) {
      // Idempotent. Re-registering is not an error — a player who reinstalls
      // and re-signs should land back in their account, not on a 409. Nothing
      // about the existing row is overwritten: silently re-pointing a
      // turboUsername on a repeat call would be a credit-redirection primitive.
      playerId = existing.id;
      active = existing.active;
      suspended = existing.suspendedAt !== null;
    } else {
      try {
        const created = await prisma.player.create({
          data: {
            walletAddress,
            passkeyCredentialId: credentialId,
            turboUsername:
              input.turboUsername.length > 0 ? input.turboUsername : null,
            displayName: input.displayName ?? null,
          },
          select: { id: true, active: true, suspendedAt: true },
        });
        playerId = created.id;
        active = created.active;
        suspended = created.suspendedAt !== null;
      } catch (e) {
        if (isUniqueViolation(e)) {
          // Either two registrations for this wallet raced (fine — re-read),
          // or passkeyCredentialId is already bound to a DIFFERENT wallet.
          const now = await prisma.player.findUnique({
            where: { walletAddress },
            select: { id: true, active: true, suspendedAt: true },
          });
          if (!now) {
            return NextResponse.json(
              { error: "registration conflict" },
              { status: 409 },
            );
          }
          playerId = now.id;
          active = now.active;
          suspended = now.suspendedAt !== null;
        } else {
          throw e;
        }
      }
    }

    // The signature just proved control of this wallet, which is the same proof
    // a login requires, so hand back a session rather than making the client
    // immediately sign a second time.
    const headers: Record<string, string> = {};
    try {
      headers["set-cookie"] = sessionCookieHeader(
        issueSession(walletAddress, credentialId),
      );
    } catch {
      // No session secret configured: registration still succeeded, the client
      // just has to log in separately. Never a reason to fail the write.
      console.error("[register] AUTH_SESSION_SECRET is not configured");
    }

    return NextResponse.json(
      {
        playerId,
        walletAddress,
        active,
        suspended,
        alreadyRegistered: Boolean(existing),
      },
      { headers },
    );
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: "invalid payload" }, { status: 400 });
    }
    if (e instanceof SyntaxError) {
      return NextResponse.json({ error: "invalid payload" }, { status: 400 });
    }
    console.error("[register] failed");
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}

function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code: unknown }).code === "P2002"
  );
}
