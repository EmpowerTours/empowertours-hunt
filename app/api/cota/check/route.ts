import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { mayOpen, mustClose, type EnforcedBound } from "@/lib/cota/enforce";

// ---------------------------------------------------------------------------
// POST /api/cota/check — the seam between a signed bound and an agent.
//
// `mandate` places real orders on Perpl and carries its own limits in Python.
// Cota carries limits a USER signed. Two implementations of the same rules
// would drift, and the copy that drifts wrong is the one guarding money — so
// there is one implementation, lib/cota/enforce.ts, and the agent asks it.
//
// ## What this proves, and what it does not
//
// The agent reports its own state. Nothing here verifies that report, and
// nothing server-side could: an agent that lies about its losses, ignores a
// denial, or simply never calls is defeated only by settlement limits on
// chain, which is a different product.
//
// What this establishes is what was ASKED and what was ANSWERED, against a
// bound the user provably signed. That is the record a dispute actually turns
// on, and it is the thing an operator running software on somebody else's
// money cannot produce today.
//
// ## Fails closed, in both directions
//
// No token configured, a bad token, an unknown digest, a revoked bound — every
// one returns `allow: false`. And the caller is expected to treat an
// unreachable endpoint the same way: refuse to open, flatten what is open.
// A limit that stops applying when the network hiccups is not a limit.
// ---------------------------------------------------------------------------

const scaled = z.string().regex(/^\d{1,78}$/);

const CheckInput = z.object({
  /** EIP-712 digest of the signed Cota. Identifies the bound. */
  digest: z.string().regex(/^0x[0-9a-fA-F]{64}$/),

  /** The agent's own account state, as it reports it. */
  state: z.object({
    tradesToday: z.number().int().min(0).max(1_000_000),
    lossTodayUsdE6: scaled,
    openNotionalUsdE6: scaled,
  }),

  /**
   * The order being proposed. Omit to ask the other question — "must I close
   * what I already hold" — which is the one that has to be polled, because a
   * position can cross a loss ceiling with nobody placing an order at all.
   */
  order: z
    .object({
      venue: z.string().min(1).max(32),
      market: z.string().min(1).max(32),
      notionalUsdE6: scaled,
      leverageX100: scaled,
    })
    .optional(),
});

function unauthorised() {
  return NextResponse.json(
    { allow: false, reason: "unauthorised" },
    { status: 401 },
  );
}

export async function POST(req: Request) {
  try {
    const expected = process.env.COTA_AGENT_TOKEN;
    // Unset means the seam is closed, not open. A deployment that forgot to
    // configure this must not answer agents.
    if (expected === undefined || expected.length < 16) return unauthorised();

    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${expected}`) return unauthorised();

    const parsed = CheckInput.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { allow: false, reason: "bad_request" },
        { status: 400 },
      );
    }
    const input = parsed.data;

    const row = await prisma.cota.findUnique({
      where: { digest: input.digest },
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
        revokedAt: true,
      },
    });
    if (row === null) {
      return NextResponse.json(
        { allow: false, reason: "unknown_cota" },
        { status: 404 },
      );
    }

    const bound: EnforcedBound = {
      venue: row.venue,
      markets: row.markets,
      maxNotionalUsdE6: BigInt(row.maxNotionalUsdE6.toFixed(0)),
      maxLeverageX100: BigInt(row.maxLeverageX100.toFixed(0)),
      maxDailyLossUsdE6: BigInt(row.maxDailyLossUsdE6.toFixed(0)),
      maxTradesPerDay: row.maxTradesPerDay,
      notBefore: BigInt(Math.floor(row.notBefore.getTime() / 1000)),
      notAfter: BigInt(Math.floor(row.notAfter.getTime() / 1000)),
      revokedAt: row.revokedAt,
    };

    const state = {
      tradesToday: input.state.tradesToday,
      lossTodayUsdE6: BigInt(input.state.lossTodayUsdE6),
      openNotionalUsdE6: BigInt(input.state.openNotionalUsdE6),
    };

    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));

    const decision = input.order
      ? mayOpen(
          bound,
          state,
          {
            venue: input.order.venue,
            market: input.order.market,
            notionalUsdE6: BigInt(input.order.notionalUsdE6),
            leverageX100: BigInt(input.order.leverageX100),
          },
          nowSeconds,
        )
      : mustClose(bound, state, nowSeconds);

    // Denials and order attempts are recorded; a `close` poll that returns
    // allow is the steady state and would grow without bound. What gets read
    // back later is exactly what is kept.
    const worthRecording = !decision.ok || input.order !== undefined;
    if (worthRecording) {
      await prisma.cotaCheck.create({
        data: {
          cotaId: row.id,
          kind: input.order ? "open" : "close",
          allowed: decision.ok,
          reason: decision.ok ? null : decision.reason,
          tradesToday: input.state.tradesToday,
          lossTodayUsdE6: input.state.lossTodayUsdE6,
          openNotionalUsdE6: input.state.openNotionalUsdE6,
          market: input.order?.market ?? null,
          notionalUsdE6: input.order?.notionalUsdE6 ?? null,
          leverageX100: input.order?.leverageX100 ?? null,
        },
      });
    }

    return NextResponse.json({
      allow: decision.ok,
      reason: decision.ok ? null : decision.reason,
    });
  } catch (err) {
    console.error("[cota/check] failed", err);
    // Even an unexpected failure answers "no". The caller cannot distinguish
    // this from a denial, and should not: both mean do not trade.
    return NextResponse.json(
      { allow: false, reason: "server_error" },
      { status: 500 },
    );
  }
}
