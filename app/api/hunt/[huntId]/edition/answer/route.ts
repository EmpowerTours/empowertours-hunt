import { NextResponse } from "next/server";
import { createPublicClient, http, type Address } from "viem";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { AuthError, clientIp, requirePlayer } from "@/lib/auth";
import { checkLimit } from "@/lib/ratelimit";
import { monad, monadRpcUrl } from "@/lib/monad";
import { isBuyable, relayerConfig, relayLicense } from "@/lib/editions/relayer";
import { checkPayment } from "@/lib/editions/payment";
import { toWei } from "@/lib/wei";

// ---------------------------------------------------------------------------
// POST /api/hunt/[huntId]/edition/answer — yes or no to the card.
//
// ## The order, and why it is this order
//
//   1. NO is cheap and final: stamp dismissedAt and stop. Nothing else runs.
//   2. Claim the card atomically — a conditional UPDATE ... WHERE takenAt IS
//      NULL AND dismissedAt IS NULL AND expiresAt > now(). Two taps race here
//      and exactly one wins; never a read-then-write.
//   3. Ask the venue whether it would still sell. This is BEFORE the payment
//      is accepted, because `salesPaused` is invisible to the catalogue and
//      the alternative is "take their money, fail, refund it".
//   4. Verify the payment on chain: right payer, right recipient, enough,
//      confirmed, and a hash nobody has spent before.
//   5. Reserve the claim, then relay. The row exists before any chain work,
//      so a concurrent second attempt hits the unique index rather than the
//      relayer.
//
// A FREE edition skips 4 entirely: the relayer pays and the hunter signs
// nothing on chain, which is the only path that works at a zero balance.
// ---------------------------------------------------------------------------

const Input = z.object({
  editionId: z.string().min(1).max(64),
  answer: z.enum(["yes", "no"]),
  /** The hunter's own transfer to the relayer. Required for a PURCHASE. */
  paymentTxHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .optional(),
});

/** How many blocks before a payment counts. */
const MIN_CONFIRMATIONS = 1;

export async function POST(
  req: Request,
  ctx: { params: Promise<{ huntId: string }> },
) {
  try {
    const { huntId } = await ctx.params;
    const player = await requirePlayer(req);

    // Money path, so the same bucket a collect uses.
    const limit = await checkLimit("claim", {
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
    const { editionId, answer, paymentTxHash } = parsed.data;

    const now = new Date();
    const edition = await prisma.edition.findFirst({
      where: { id: editionId, huntId, playerId: player.id },
    });
    if (!edition) {
      return NextResponse.json(
        { ok: false, reason: "edition_not_found" },
        { status: 404 },
      );
    }
    if (edition.takenAt !== null) {
      return NextResponse.json({ ok: false, reason: "edition_already_taken" });
    }
    if (edition.dismissedAt !== null) {
      return NextResponse.json({ ok: false, reason: "edition_dismissed" });
    }
    if (edition.expiresAt <= now) {
      return NextResponse.json({ ok: false, reason: "edition_expired" });
    }

    // ---- NO ---------------------------------------------------------------
    // Recorded rather than left to expire, so the card is not shown again the
    // moment it is closed. Declining is an answer.
    if (answer === "no") {
      await prisma.edition.updateMany({
        where: { id: edition.id, takenAt: null, dismissedAt: null },
        data: { dismissedAt: now },
      });
      return NextResponse.json({ ok: true, dismissed: true });
    }

    // ---- YES --------------------------------------------------------------
    const cfg = relayerConfig();
    if (cfg === null) {
      return NextResponse.json(
        { ok: false, reason: "price_moved" },
        { status: 503 },
      );
    }

    const isFree = edition.terms === "FREE";
    const priceWei = edition.priceWei === null ? 0n : toWei(edition.priceWei);

    // Would the venue still sell it? Before any money is accepted.
    const buyable = await isBuyable(
      cfg,
      BigInt(edition.masterId),
      edition.tier === "COLLECTOR",
      priceWei,
    );
    if (!buyable.ok) {
      return NextResponse.json({ ok: false, reason: buyable.reason });
    }

    // Verify the hunter's payment before claiming the card, so a failed
    // payment does not consume their one chance at this edition.
    if (!isFree) {
      if (!paymentTxHash) {
        return NextResponse.json(
          { ok: false, reason: "payment_too_small" },
          { status: 400 },
        );
      }
      const client = createPublicClient({
        chain: monad,
        transport: http(monadRpcUrl()),
      });
      let transfer;
      try {
        const [receipt, tx, head] = await Promise.all([
          client.getTransactionReceipt({
            hash: paymentTxHash as `0x${string}`,
          }),
          client.getTransaction({ hash: paymentTxHash as `0x${string}` }),
          client.getBlockNumber(),
        ]);
        transfer = {
          from: tx.from,
          to: tx.to,
          valueWei: tx.value,
          status:
            receipt.status === "success"
              ? ("success" as const)
              : ("reverted" as const),
          confirmations: Number(head - receipt.blockNumber) + 1,
        };
      } catch {
        // Not mined yet, or no such hash. Unconfirmed rather than invalid —
        // the client can try again in a moment.
        return NextResponse.json({ ok: false, reason: "payment_unconfirmed" });
      }

      const check = checkPayment(transfer, {
        payer: player.walletAddress,
        relayer: cfg.relayerAddress,
        priceWei,
        minConfirmations: MIN_CONFIRMATIONS,
      });
      if (!check.ok) {
        return NextResponse.json({ ok: false, reason: check.reason });
      }
    }

    // Claim the card. Conditional UPDATE, so two taps race here and exactly
    // one wins. affectedRows is the decision; never a read-then-write.
    const taken = await prisma.edition.updateMany({
      where: {
        id: edition.id,
        takenAt: null,
        dismissedAt: null,
        expiresAt: { gt: now },
      },
      data: { takenAt: now },
    });
    if (taken.count !== 1) {
      return NextResponse.json({ ok: false, reason: "edition_already_taken" });
    }

    // Reserve BEFORE any chain work. The unique index on
    // (playerId, collection, masterId, tier) is what makes a double-claim
    // impossible, and the one on paymentTxHash is what stops a replay.
    let claimId: string;
    try {
      const claim = await prisma.editionClaim.create({
        data: {
          playerId: player.id,
          editionId: edition.id,
          collection: edition.collection,
          masterId: edition.masterId,
          tier: edition.tier,
          walletAddress: player.walletAddress,
          paidWei: priceWei.toString(),
          paymentTxHash: isFree ? null : (paymentTxHash ?? null),
          status: "PENDING",
        },
        select: { id: true },
      });
      claimId = claim.id;
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") {
        // Either they already hold this work at this tier, or that payment
        // hash has been spent. Both are the constraint doing its job.
        return NextResponse.json({ ok: false, reason: "already_owned" });
      }
      throw err;
    }

    const result = await relayLicense(
      cfg,
      {
        collection: edition.collection as Address,
        masterId: BigInt(edition.masterId),
        isCollector: edition.tier === "COLLECTOR",
        // A fallback only. relayLicense reads the master's own tokenURI and prefers it,
        // because one env var cannot describe every track in the catalogue. Left here so a
        // deployment can still pin a uri deliberately if it ever needs to.
        licenseUri: process.env.EDITION_LICENSE_URI ?? "",
      },
      player.walletAddress as Address,
    );

    if (!result.ok) {
      // The money has moved and the licence has not. Recorded with the
      // payment hash so it can be made good by hand — deliberately NOT
      // auto-refunded, because an automatic second money movement on a path
      // that just failed is how one bad minute becomes two.
      await prisma.editionClaim.update({
        where: { id: claimId },
        data: {
          status: "FAILED",
          failReason: result.error ?? "relay failed",
          purchaseTxHash: result.purchaseTxHash ?? null,
          licenseId: result.licenseId ?? null,
        },
      });
      console.error("[hunt/edition/answer] relay failed", {
        claimId,
        paymentTxHash,
        error: result.error,
      });
      return NextResponse.json(
        { ok: false, reason: "relay_failed" },
        { status: 502 },
      );
    }

    await prisma.editionClaim.update({
      where: { id: claimId },
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
    console.error("[hunt/edition/answer] failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}
