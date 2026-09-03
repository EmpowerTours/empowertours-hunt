import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { AuthError, clientIp, requirePlayer } from "@/lib/auth";
import { checkLimit } from "@/lib/ratelimit";
import { fromWei, toWei } from "@/lib/wei";
import { isTierName, readTierPriceWei } from "@/lib/hunt/cohort";
import { monthsAffordable, planRedemption } from "@/lib/hunt/redeem";

// ---------------------------------------------------------------------------
// Spending TURBO credit on months of a TurboCohort subscription.
//
//   POST  redeem  — debit credit atomically, record what is owed
//   GET   status  — balance, what it buys today, and past redemptions
//
// ## The debit is a conditional UPDATE, never a read-then-write
//
// The balance check and the decrement are ONE statement with a `gte` in its
// WHERE clause, and the affected-row count is what decides success. Reading the
// balance and then writing it is the bug this whole codebase is careful about:
// K concurrent requests all read the same balance, all decide there is enough,
// and the player redeems (K-1) months they never earned. Same pattern as the
// spawn budget and the credit ceiling.
//
// ## Settlement is a person, and that is forced by the chain
//
// The deployed TurboCohort exposes only `payMonthly(uint8)`, which pays for
// `msg.sender`. There is no pay-on-behalf function — verified against the
// deployed bytecode, not just the ABI the app happens to use — so no treasury
// can buy a membership for somebody else. A redemption therefore records a
// debt the cohort owes the player, and an operator settles it. Pretending
// otherwise would mean marking months granted that nobody granted.
// ---------------------------------------------------------------------------

const RedeemInput = z.object({
  tier: z.string().min(1).max(16),
  months: z.number().int().min(1).max(12),
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

    const parsed = RedeemInput.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "bad request" }, { status: 400 });
    }
    const { tier, months } = parsed.data;

    if (!isTierName(tier)) {
      return NextResponse.json({ error: "unknown tier" }, { status: 400 });
    }

    const tierPriceWei = await readTierPriceWei(tier);
    if (tierPriceWei === null) {
      // Deliberately not a fallback price. A guess here is a guess at what
      // somebody owes, and a zero would mint free months on a bad RPC day.
      return NextResponse.json({ error: "no_price" }, { status: 503 });
    }

    const costWei = tierPriceWei * BigInt(months);
    const costParam = fromWei(costWei);

    const result = await prisma.$transaction(async (tx) => {
      // THE atomic step. `gte` in the WHERE plus a decrement in one statement;
      // count === 0 means somebody else spent the credit first.
      const debited = await tx.player.updateMany({
        where: { id: player.id, creditBalanceWei: { gte: costParam } },
        data: { creditBalanceWei: { decrement: costParam } },
      });
      if (debited.count !== 1) return { ok: false as const };

      // The balance the database actually produced, so the ledger records what
      // happened rather than what we predicted would happen.
      const after = await tx.player.findUniqueOrThrow({
        where: { id: player.id },
        select: { creditBalanceWei: true },
      });
      const balanceAfterWei = toWei(after.creditBalanceWei);

      // Re-derived from the post-debit balance, so the pure helper's own
      // refusals still see real numbers.
      const plan = planRedemption(
        balanceAfterWei + costWei,
        tierPriceWei,
        months,
      );
      if (!plan.ok) throw new Error(`plan refused after debit: ${plan.reason}`);

      const entry = await tx.creditLedger.create({
        data: {
          playerId: player.id,
          reason: plan.debit.reason,
          amountWei: fromWei(plan.debit.amountWei),
          balanceAfterWei: fromWei(balanceAfterWei),
          note: `${months} month(s) of ${tier}`,
        },
        select: { id: true },
      });

      const redemption = await tx.redemption.create({
        data: {
          playerId: player.id,
          months,
          tier,
          costCreditWei: costParam,
          tierPriceWei: fromWei(tierPriceWei),
          ledgerEntryId: entry.id,
        },
        select: {
          id: true,
          months: true,
          tier: true,
          status: true,
          createdAt: true,
        },
      });

      return { ok: true as const, redemption, balanceAfterWei };
    });

    if (!result.ok) {
      return NextResponse.json({ error: "not_enough_credit" }, { status: 409 });
    }

    return NextResponse.json(
      {
        ok: true,
        redemption: result.redemption,
        creditBalanceWei: result.balanceAfterWei.toString(),
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    console.error("[redeem] POST failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    const player = await requirePlayer(req);

    const [row, redemptions] = await Promise.all([
      prisma.player.findUniqueOrThrow({
        where: { id: player.id },
        select: { creditBalanceWei: true },
      }),
      prisma.redemption.findMany({
        where: { playerId: player.id },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true,
          months: true,
          tier: true,
          status: true,
          costCreditWei: true,
          settledAt: true,
          createdAt: true,
        },
      }),
    ]);

    const balanceWei = toWei(row.creditBalanceWei);
    const tierPriceWei = await readTierPriceWei("EXPLORER");

    return NextResponse.json({
      creditBalanceWei: balanceWei.toString(),
      // Null when the chain could not be read — the UI must be able to tell
      // "you can afford nothing" apart from "we don't know the price".
      tierPriceWei: tierPriceWei === null ? null : tierPriceWei.toString(),
      monthsAffordable:
        tierPriceWei === null
          ? null
          : monthsAffordable(balanceWei, tierPriceWei),
      redemptions: redemptions.map((r) => ({
        ...r,
        costCreditWei: r.costCreditWei.toFixed(0),
      })),
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    console.error("[redeem] GET failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}
