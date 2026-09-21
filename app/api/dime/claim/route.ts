import { NextResponse } from "next/server";
import { type Address } from "viem";
import { prisma } from "@/lib/db/prisma";
import { AuthError, clientIp, requirePlayer } from "@/lib/auth";
import { checkLimit } from "@/lib/ratelimit";
import { readCatalogue } from "@/lib/editions/catalogue";
import {
  isBuyable,
  relayerCapacity,
  relayerConfig,
  relayLicense,
} from "@/lib/editions/relayer";

// ---------------------------------------------------------------------------
// POST /api/dime/claim — one free licence of the giveaway work, for the
// signed-in passkey wallet.
//
// ## Why this page still exists after editions were built
//
// It is not a hunt mechanic and it is not a duplicate of one. An edition is
// FOUND: you walk to it. This is a LANDING PAGE for cold traffic — an X or
// TikTok audience who are not hunters, mostly have no wallet, and will not
// install anything. What makes it work for them is the same thing that makes
// it look redundant: no wallet, no seed phrase, no app. Tap once, the passkey
// silently makes a wallet, the relayer pays both gas fees.
//
// It shares the hunt's identity and the EDITION claim table on purpose, so a
// visitor who claims here and later starts hunting is the same passkey, the
// same wallet, and cannot take the same work twice.
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

/**
 * Which work this page gives away.
 *
 * A single master id, separate from the edition catalogue, because a campaign
 * is not the catalogue: the giveaway runs on one song for one promotion and
 * ends, while editions come and go with what is active on the venue.
 *
 * Null when unset, which closes the page rather than crashing it — the same
 * posture relayerConfig() takes.
 */
function giveaway(): { masterId: bigint; licenseUri: string } | null {
  const id = process.env.DIME_GIVEAWAY_MASTER_ID;
  if (!id || !/^\d+$/.test(id)) return null;
  return {
    masterId: BigInt(id),
    licenseUri: process.env.DIME_GIVEAWAY_LICENSE_URI ?? "",
  };
}

export async function POST(req: Request) {
  try {
    const cfg = relayerConfig();
    const drop = giveaway();
    if (cfg === null || drop === null) {
      return NextResponse.json(
        { error: "the drop is not open right now" },
        { status: 503 },
      );
    }
    // The claim is keyed on the work, so the giveaway and a found edition of
    // the same song are the same row and the same "once, forever" rule.
    // STANDARD, always. This page exists to put a wallet on a stranger's
    // phone; the COLLECTOR edition is the capped, priced thing they can buy
    // afterwards, and keying the claim by tier is what keeps that possible.
    const key = {
      collection: cfg.licenseRegistry,
      masterId: drop.masterId.toString(),
      tier: "STANDARD" as const,
    };

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
    const existing = await prisma.editionClaim.findUnique({
      where: {
        playerId_collection_masterId_tier: { playerId: player.id, ...key },
      },
      select: { id: true, status: true, transferTxHash: true, licenseId: true },
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
        ? await prisma.editionClaim.update({
            where: { id: existing.id },
            data: {
              status: "PENDING",
              walletAddress: player.walletAddress,
              failReason: null,
            },
            select: { id: true },
          })
        : await prisma.editionClaim.create({
            data: {
              playerId: player.id,
              ...key,
              walletAddress: player.walletAddress,
              // Given away, so nothing was charged. Recorded rather than
              // implied: a receipt has to say what was paid, and zero is an
              // answer.
              paidWei: "0",
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
    // Scoped to this work. Counting every EditionClaim would let a busy hunt
    // exhaust a giveaway nobody had claimed.
    const claimed = await prisma.editionClaim.count({
      where: { ...key, status: { in: ["PENDING", "SENT"] } },
    });
    if (claimed > maxClaims()) {
      await prisma.editionClaim.update({
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

    const result = await relayLicense(
      cfg,
      { collection: cfg.licenseRegistry, isCollector: false, ...drop },
      player.walletAddress as Address,
    );

    if (!result.ok) {
      await prisma.editionClaim.update({
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

    await prisma.editionClaim.update({
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
    const drop = giveaway();

    // ---- Configured is not the same as able to pay, and this page is the
    // one place where that difference is expensive.
    //
    // `open` used to mean only "the env vars are present". A relayer with the
    // key set and an empty wallet therefore showed cold traffic a working SÍ
    // button that failed on every tap -- and this is a landing page for people
    // who arrived from a social post, have no wallet and will not try twice.
    //
    // The giveaway is FREE, so nobody pays the relayer for these: it funds the
    // whole price itself, every time. Its balance is the real cap on the drop,
    // and the button should agree with it.
    //
    // `isBuyable` answers both halves at once when handed the capacity as the
    // quote: it refuses a paused work, a zero price, and any price the relayer
    // could not cover.
    let fundable = true;
    if (cfg !== null && drop !== null) {
      const capacity = await relayerCapacity(cfg);
      // Null is "could not ask", not "broke". A transient RPC failure must not
      // close a live drop -- and if it is wrong, the claim path fails cleanly
      // and the row is reusable, so the visitor can try again.
      if (capacity !== null) {
        fundable = (await isBuyable(cfg, drop.masterId, false, capacity)).ok;
      }
    }

    const open = cfg !== null && drop !== null && fundable;
    const key =
      cfg && drop
        ? {
            collection: cfg.licenseRegistry,
            masterId: drop.masterId.toString(),
            // Matches the POST. This page only ever deals the STANDARD tier.
            tier: "STANDARD" as const,
          }
        : null;

    const claimed = key
      ? await prisma.editionClaim.count({
          where: { ...key, status: { in: ["PENDING", "SENT"] } },
        })
      : 0;
    const remaining = Math.max(0, maxClaims() - claimed);

    let mine: { status: string; transferTxHash: string | null } | null = null;
    try {
      const player = await requirePlayer(req);
      const row = key
        ? await prisma.editionClaim.findUnique({
            where: {
              playerId_collection_masterId_tier: {
                playerId: player.id,
                ...key,
              },
            },
            select: { status: true, transferTxHash: true },
          })
        : null;
      mine = row;
    } catch (err) {
      if (!(err instanceof AuthError)) throw err;
    }

    // ---- The cover art, from the venue rather than from a constant.
    //
    // The page drew a hardcoded gradient with a comment calling it a stand-in
    // "until the master's image is wired in". Master 13 has had real artwork
    // the whole time; this is a landing page for cold traffic off a social
    // post, and a placeholder where the cover should be is the first thing
    // they see.
    //
    // readCatalogue is the right source rather than a fresh chain read: it
    // already resolves the ipfs:// tokenURI to a usable https image, caches
    // for five minutes and single-flights, which matters on the most-hit
    // route in the app. A failure leaves art null and the page falls back to
    // the gradient — never an empty box.
    let art: { name: string; imageUrl: string | null } | null = null;
    if (drop !== null) {
      const cat = await readCatalogue();
      if (cat.ok) {
        const entry = cat.entries.find(
          (e) => e.masterId === drop.masterId.toString(),
        );
        if (entry) art = { name: entry.name, imageUrl: entry.imageUrl };
      }
    }

    return NextResponse.json({ open, remaining, mine, art });
  } catch (err) {
    console.error("[dime/claim] GET failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}
