import { NextResponse } from "next/server";
import { createPublicClient, http } from "viem";
import { prisma } from "@/lib/db/prisma";
import { AuthError, clientIp, requirePlayer } from "@/lib/auth";
import { checkLimit } from "@/lib/ratelimit";
import { monad, monadRpcUrl } from "@/lib/monad";
import { readCatalogue } from "@/lib/editions/catalogue";
import { relayerCapacity, relayerConfig } from "@/lib/editions/relayer";
import { unexplainedLicences } from "@/lib/editions/ownership";
import {
  deriveEdition,
  evaluateEditionEligibility,
  heldKey,
  leastRecentlyOffered,
  placeableFor,
  quotedPrice,
} from "@/lib/hunt/edition";
import { placeEdition } from "@/lib/hunt/edition-place";
import { toWei } from "@/lib/wei";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// GET /api/hunt/[huntId]/edition — "have I bumped into anyone?"
//
// Polled alongside the spawn scan. Returns the live card if there is one, or
// a reason there is not, and creates one when the player is due.
//
// ## Why this is a GET that writes
//
// It mirrors the spawn scan, which has the same shape for the same reason:
// the client cannot know whether it is due an encounter, so asking IS the
// trigger. The write is idempotent in the way that matters — an existing live
// card is returned rather than a second one created, and the cooldown is the
// bound on how often one can appear.
//
// ## What is deliberately NOT checked
//
// No GPS accuracy, no clock skew, no plausible speed, no proximity, no
// verified position. Those guard a spawn, which pays the TREASURY for
// reaching a place; faking a position there steals. An edition takes the
// HUNTER's money, so a spoofer who fakes an encounter has bought something.
// See lib/hunt/edition.ts.
// ---------------------------------------------------------------------------

/** What the card needs, and nothing the hunter has no business seeing. */
function view(
  e: {
    id: string;
    collection: string;
    masterId: string;
    kind: string;
    tier: string;
    terms: string;
    priceWei: unknown;
    expiresAt: Date;
  },
  display: { name: string; imageUrl: string | null; previewUrl: string | null },
) {
  return {
    id: e.id,
    collection: e.collection,
    masterId: e.masterId,
    kind: e.kind,
    tier: e.tier,
    terms: e.terms,
    priceWei: e.priceWei === null ? null : String(e.priceWei),
    expiresAt: e.expiresAt.toISOString(),
    ...display,
  };
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ huntId: string }> },
) {
  try {
    const { huntId } = await ctx.params;
    const player = await requirePlayer(req);

    // Shares the spawn bucket: both are polled on the same loop, and a script
    // hammering this would hammer that too.
    const limit = await checkLimit("spawn", {
      playerId: player.id,
      ip: clientIp(req),
    });
    if (!limit.ok) {
      return NextResponse.json({ error: "slow down" }, { status: 429 });
    }

    const now = new Date();
    const hunt = await prisma.hunt.findUnique({ where: { id: huntId } });
    if (!hunt) {
      return NextResponse.json({ error: "hunt not found" }, { status: 404 });
    }

    // A live card is one that has not been answered either way and has not
    // timed out. `dismissedAt` counts as answered — declining must not leave
    // the card hanging around blocking the next one.
    const live = await prisma.edition.findFirst({
      where: {
        huntId,
        playerId: player.id,
        takenAt: null,
        dismissedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: "desc" },
    });

    const catalogue = await readCatalogue();
    const entries = catalogue.ok ? catalogue.entries : [];
    const byMaster = new Map(
      entries.map((e) => [`${e.collection}/${e.masterId}/${e.tier}`, e]),
    );

    if (live) {
      const d = byMaster.get(
        `${live.collection}/${live.masterId}/${live.tier}`,
      );
      return NextResponse.json({
        offered: true,
        // ---- The SAME payTo the new-card branch sends, and its absence here
        // made every purchase impossible after the first poll.
        //
        // HuntScreen re-runs this fetch on every scan tick and stores
        // `payTo: body.payTo ?? null`. A card lives 300s, so the first tick
        // created it and returned payTo, and the very next tick returned this
        // branch without one — overwriting it with null. EditionCard then bails
        // at `if (!payTo)` before it ever signs, so the hunter taps BUY, sees
        // "something went wrong", and no money moves and no claim row is
        // written. Reproduced on master 8 at 35 MON against a 95 MON wallet.
        //
        // A response that offers a card MUST carry everywhere to pay it.
        payTo: relayerConfig()?.relayerAddress ?? null,
        edition: view(live, {
          // The venue may have dropped the work since the card was created.
          // The card still stands — the price was quoted and is honoured —
          // so fall back to the id rather than hiding a live offer.
          name: d?.name ?? `#${live.masterId}`,
          imageUrl: d?.imageUrl ?? null,
          previewUrl: d?.previewUrl ?? null,
        }),
      });
    }

    // Everything this passkey already holds, at the tier it holds it. Tier is
    // in the key so owning the standard licence does not bar the collector.
    const claims = await prisma.editionClaim.findMany({
      where: { playerId: player.id, status: { in: ["PENDING", "SENT"] } },
      select: { collection: true, masterId: true, tier: true },
    });
    const held = new Set(claims.map((c) => heldKey(c)));
    // Per master and ACROSS tiers, because the chain's cheap read is
    // tier-blind and this is what gets subtracted from it.
    const knownPerMaster = new Map<string, number>();
    for (const c of claims) {
      const k = `${c.collection}/${c.masterId}`;
      knownPerMaster.set(k, (knownPerMaster.get(k) ?? 0) + 1);
    }

    // Their own wallet, read from chain. There is no internal balance: hunt
    // payouts land in the hunter's wallet, so this IS the spendable figure.
    // An RPC hiccup means zero placeable rather than a crash — they are told
    // nothing is on offer, which is true enough for one poll.
    let balanceWei = 0n;
    try {
      const client = createPublicClient({
        chain: monad,
        transport: http(monadRpcUrl()),
      });
      balanceWei = await client.getBalance({
        address: player.walletAddress as `0x${string}`,
      });
    } catch {
      // Stays 0n.
    }

    const gasBuffer = toWei(hunt.editionGasBufferWei);
    let placeable = placeableFor(entries, held, balanceWei, gasBuffer);

    // ---- And what the RELAYER can settle, which is the other half of the
    // same question and the only one that is asked before the hunter pays.
    //
    // EditionCard signs the payment and THEN calls the answer route, so every
    // refusal the server makes "before taking their money" actually happens
    // after it has moved. Placement is the last honest gate: a work the
    // relayer could not buy must never become a card.
    //
    // Null means the relayer could not be asked, not that it is broke. That
    // leaves the list alone rather than emptying it -- an RPC hiccup must not
    // be reported to a player as "there is nothing here", the same rule the
    // catalogue follows.
    const cfgForCapacity = relayerConfig();
    if (cfgForCapacity !== null) {
      const capacity = await relayerCapacity(cfgForCapacity);
      if (capacity !== null) {
        placeable = placeable.filter(
          (o) => o.terms === "FREE" || (o.priceWei ?? 0n) <= capacity,
        );
      }
    }

    // ---- What this player has already been SHOWN, newest first.
    //
    // Not scoped to this hunt, because the rotation is about what they have
    // seen: a second hunt must not restart the carousel at the same track.
    // `take` bounds it — the rotation needs only the most recent sighting of
    // each work, so a window a few catalogues deep is enough and the cost
    // stays flat for somebody who has been hunting for months.
    const offered = await prisma.edition.findMany({
      where: { playerId: player.id },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        huntId: true,
        collection: true,
        masterId: true,
        tier: true,
        createdAt: true,
      },
    });
    const lastOfferedAt = new Map<string, number>();
    for (const e of offered) {
      const k = heldKey({
        collection: e.collection,
        masterId: e.masterId,
        tier: e.tier,
      });
      // Newest first, so the first sighting of a key is its latest one.
      if (!lastOfferedAt.has(k)) lastOfferedAt.set(k, e.createdAt.getTime());
    }
    // The cooldown IS per hunt, and the ordered list above already answers it.
    const lastEditionAt =
      offered.find((e) => e.huntId === huntId)?.createdAt ?? null;

    // The session warm-up, armed by the check-in route. No row means this
    // player has never checked in here, so the clock starts NOW rather than
    // being waived — a hunter who has not arrived must not be handed a card
    // on their first poll.
    const stats = await prisma.playerHunt.findUnique({
      where: { huntId_playerId: { huntId, playerId: player.id } },
      select: { editionsOpenAt: true },
    });

    const eligibility = evaluateEditionEligibility({
      serverNow: now,
      playerActive: player.active && player.suspendedAt === null,
      huntActive: hunt.active,
      editionsEnabled: hunt.editionsEnabled,
      lastEditionAt,
      editionCooldownSeconds: hunt.editionCooldownSeconds,
      editionsOpenAt: stats?.editionsOpenAt ?? now,
      hasActiveEdition: false, // already returned above when there was one
      placeableCount: placeable.length,
      catalogueUnavailable: !catalogue.ok,
    });

    if (!eligibility.ok) {
      return NextResponse.json({ offered: false, reason: eligibility.reason });
    }

    // Narrow to the works seen least recently BEFORE the draw, never after.
    // Affordability and relayer capacity had already cut twelve offers down
    // to two for a real wallet, and a uniform draw over two is how the same
    // track came up three times out of four. Rotating first makes that
    // alternation; it does not touch the draw, which stays uniform over the
    // ties it is handed.
    const draw = deriveEdition(`edn_${randomBytes(16).toString("hex")}`, {
      catalogue: leastRecentlyOffered(placeable, lastOfferedAt),
    });
    const price = quotedPrice(draw.offer);

    // The price is written onto the row, not re-read when they answer. A
    // hunter shown 300 WMON must be charged 300 WMON; the relayer absorbs any
    // movement at the venue inside the TTL, which is the right party — it
    // chose the TTL and the hunter cannot see the venue at all.
    // ---- ATOMIC. Every check above is a read-then-write, and the client
    // genuinely fires two of these at once: see lib/hunt/edition-place.ts for
    // the mechanism and for the two rows it put in the live database one
    // millisecond apart.
    const created = await placeEdition(prisma, {
      huntId,
      playerId: player.id,
      collection: draw.offer.collection,
      masterId: draw.offer.masterId,
      kind: draw.offer.kind,
      tier: draw.offer.tier,
      terms: draw.offer.terms,
      priceWei: price,
      now,
      expiresAt: new Date(now.getTime() + hunt.editionTtlSeconds * 1000),
      cooldownCutoff: new Date(
        now.getTime() - hunt.editionCooldownSeconds * 1000,
      ),
    });

    if (created === null) {
      // The other request won, and it is holding the card this one would have
      // created. Re-read rather than invent a second: answering
      // `offered: false` here would blank a card the hunter is looking at.
      const other = await prisma.edition.findFirst({
        where: {
          huntId,
          playerId: player.id,
          takenAt: null,
          dismissedAt: null,
          expiresAt: { gt: now },
        },
        orderBy: { createdAt: "desc" },
      });
      if (other === null) {
        return NextResponse.json({
          offered: false,
          reason: "edition_cooldown",
        });
      }
      const od = byMaster.get(
        `${other.collection}/${other.masterId}/${other.tier}`,
      );
      return NextResponse.json({
        offered: true,
        payTo: relayerConfig()?.relayerAddress ?? null,
        edition: view(other, {
          name: od?.name ?? `#${other.masterId}`,
          imageUrl: od?.imageUrl ?? null,
          previewUrl: od?.previewUrl ?? null,
        }),
      });
    }

    const d = byMaster.get(
      `${draw.offer.collection}/${draw.offer.masterId}/${draw.offer.tier}`,
    );
    // One read, for the one work being offered. A warning, never a gate —
    // see lib/editions/ownership.ts.
    const unexplained = await unexplainedLicences({
      registry: draw.offer.collection as `0x${string}`,
      owner: player.walletAddress as `0x${string}`,
      masterId: BigInt(draw.offer.masterId),
      knownCount:
        knownPerMaster.get(`${draw.offer.collection}/${draw.offer.masterId}`) ??
        0,
    });
    return NextResponse.json({
      offered: true,
      payTo: relayerConfig()?.relayerAddress ?? null,
      // Null (could not ask) renders the same as false: show nothing.
      alreadyHeld: (unexplained ?? 0) > 0,
      edition: view(created, {
        name: d?.name ?? `#${created.masterId}`,
        imageUrl: d?.imageUrl ?? null,
        previewUrl: d?.previewUrl ?? null,
      }),
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    console.error("[hunt/edition] failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}
