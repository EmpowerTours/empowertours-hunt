import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { AuthError, clientIp, requirePlayer } from "@/lib/auth";
import { checkLimit } from "@/lib/ratelimit";
import { isClientAbort } from "@/lib/aborted";
import {
  TURBO_HANDLE_MAX,
  explainLinkRefusal,
  handleKey,
  mayLinkHandle,
} from "@/lib/hunt/turboHandle";

// ---------------------------------------------------------------------------
// POST /api/me/turbo — link a TURBO builder handle to this wallet.
//
// The path `lib/auth/signIn.ts` has promised since it was written: it sends
// `turboUsername: ""` at registration with the comment "a player can attach a
// TURBO handle later", and until now there was nowhere to attach it. Every
// player row therefore has a null handle, and the wallet screen has been
// telling people their credit cannot be redeemed with no way to fix it.
//
// ## Set once, and why the check is in SQL
//
// `app/api/register/route.ts` refuses to re-point a handle on a repeat
// registration, calling it "a credit-redirection primitive". That reasoning
// applies with more force here: credit accrues to a wallet over weeks and is
// redeemed against whatever handle the row names at settlement time, so a
// mutable handle lets somebody bank credit and redirect it at the last moment.
//
// So the update is conditional — `WHERE id = ? AND turboUsername IS NULL` —
// and the affected-row count is what the response believes. Reading the row
// first and then writing it is a read-then-write, which AGENTS.md rule 4
// forbids: two requests racing both pass the predicate and the second wins
// silently.
//
// Uniqueness is the database's job for the same reason, via a unique index on
// the lowered handle. Checking "is it taken?" in application code is the same
// race with a worse failure — two wallets pointing at one builder identity.
//
// NO SIGNATURE, deliberately. /api/redeem SPENDS this credit on a session
// alone; requiring an EIP-712 signature to set the LABEL would be stricter
// than the money path, which is incoherent rather than safe. See
// lib/hunt/turboHandle.ts for why a self-declared handle is proportionate.
// ---------------------------------------------------------------------------

const LinkInput = z.object({
  handle: z
    .string()
    .min(1)
    .max(TURBO_HANDLE_MAX + 8),
});

export async function POST(req: Request) {
  try {
    const player = await requirePlayer(req);

    const limit = await checkLimit("register", {
      playerId: player.id,
      ip: clientIp(req),
    });
    if (!limit.ok) {
      return NextResponse.json({ error: "slow down" }, { status: 429 });
    }

    if (!player.active || player.suspendedAt !== null) {
      return NextResponse.json({ error: "not eligible" }, { status: 403 });
    }

    const parsed = LinkInput.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "bad request" }, { status: 400 });
    }

    const current = await prisma.player.findUniqueOrThrow({
      where: { id: player.id },
      select: { turboUsername: true },
    });

    // The shape check and the set-once rule, as one pure decision. The SQL
    // below re-states both; this exists so the player gets a sentence rather
    // than a row count.
    const check = mayLinkHandle({
      raw: parsed.data.handle,
      current: current.turboUsername,
      takenByAnother: false,
    });
    if (!check.ok) {
      return NextResponse.json(
        { error: explainLinkRefusal(check.reason, "en"), reason: check.reason },
        { status: 409 },
      );
    }

    // Already theirs — mayLinkHandle treats a re-submit as a no-op, so answer
    // success without touching the row. A double-tap is not a failure.
    if (
      current.turboUsername !== null &&
      handleKey(current.turboUsername) === handleKey(check.handle)
    ) {
      return NextResponse.json({ ok: true, handle: current.turboUsername });
    }

    try {
      // Conditional, and the count is the answer. `updateMany` rather than
      // `update` precisely because it reports how many rows matched instead of
      // throwing on none.
      const linked = await prisma.player.updateMany({
        where: { id: player.id, turboUsername: null },
        data: { turboUsername: check.handle },
      });
      if (linked.count !== 1) {
        // Somebody linked between the read and the write.
        return NextResponse.json(
          {
            error: explainLinkRefusal("already_linked", "en"),
            reason: "already_linked",
          },
          { status: 409 },
        );
      }
    } catch (e) {
      // The unique index on the lowered handle. This is the race the
      // application-code check cannot win, which is why the constraint exists.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002"
      ) {
        return NextResponse.json(
          { error: explainLinkRefusal("taken", "en"), reason: "taken" },
          { status: 409 },
        );
      }
      throw e;
    }

    return NextResponse.json({ ok: true, handle: check.handle });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    if (isClientAbort(err)) return new Response(null, { status: 499 });
    console.error("[me/turbo] failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}
