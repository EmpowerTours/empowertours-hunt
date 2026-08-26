import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requirePlayer, clientIp, AuthError } from "@/lib/auth";
import { checkLimit } from "@/lib/ratelimit";
import { withTransactionRetry, SerializationExhausted } from "@/lib/db/retry";
import { toWei, fromWei } from "@/lib/wei";
import {
  validateClaim,
  clientRejectBody,
  type HuntCache,
  type RejectReason,
} from "@/lib/hunt/validator";
import { creditForFind } from "@/lib/hunt/credit";

// THIS ROUTE IS A LOCATION ORACLE UNLESS IT IS CAREFUL.
//
// Every distinguishable outcome is a bit of information about where the caches
// are, and the probe that extracts the bit is the same request that pays. An
// attacker who can tell "no cache here" from "you already have this one" from
// "budget exhausted" grid-searches at ~35m spacing (half the smallest radius)
// and maps the whole hunt without walking anywhere. Two rules follow, and both
// are load-bearing:
//
//   * The client is told exactly one rejection string, ever. See
//     clientRejectBody / OPAQUE_CLIENT_REASON in lib/hunt/validator.ts. The
//     precise reason is kept, but it goes to ClaimAttempt for the audit.
//   * The request is rate limited BEFORE any of the work that would answer the
//     question, so the search is expensive even in the degenerate case.
//
// Nothing here returns a global statistic either — the hunt-wide find count
// used to be attached to the budget rejection, which handed a probe an
// aggregate that no player needs and that tracks other players' activity.

// Player-supplied and therefore untrusted. Bounds here are sanity bounds; the
// real decision is validateClaim's.
//
// `.finite()` is not decoration: `z.number().nonnegative()` accepts Infinity,
// and an infinite accuracy sails through every `<=` comparison downstream in
// exactly the way a NaN sails through every `>`.
const ClaimInput = z.object({
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
  accuracyM: z.number().finite().nonnegative().nullable(),
  clientTs: z.string().datetime(),
});

/**
 * Thrown inside the commit transaction when an atomic ceiling refuses the
 * find. Carries the audit reason so the ClaimAttempt row written afterwards
 * states the FINAL outcome.
 */
class CeilingRejected extends Error {
  constructor(readonly auditReason: RejectReason) {
    super(auditReason);
    this.name = "CeilingRejected";
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ huntId: string }> },
) {
  const { huntId } = await params;

  try {
    // Auth first, and ONLY because the limiter is keyed on the player as well
    // as the IP — a per-IP-only limit is defeated by a phone hotspot, and a
    // per-player-only limit is defeated by registering wallets. Nothing about
    // the hunt, the caches or the player's finds is read until the limiter has
    // said yes, and the request body is not even parsed.
    const player = await requirePlayer(req);

    const limit = await checkLimit("claim", {
      playerId: player.id,
      ip: clientIp(req),
    });
    if (!limit.ok) {
      // No body, no reason, no hint about what was being claimed.
      return NextResponse.json(
        { error: "slow down" },
        {
          status: 429,
          headers: {
            "Retry-After": String(
              Math.max(0, Math.ceil((limit.resetAt - Date.now()) / 1000)),
            ),
          },
        },
      );
    }

    const input = ClaimInput.parse(await req.json());
    const clientTs = new Date(input.clientTs);
    const serverNow = new Date();

    const hunt = await prisma.hunt.findUnique({
      where: { id: huntId },
      include: { caches: { where: { active: true } } },
    });
    if (!hunt) {
      return NextResponse.json({ error: "hunt not found" }, { status: 404 });
    }

    // Found caches are per-hunt: a find in another hunt says nothing about
    // which cache in THIS hunt is still open.
    const huntFinds = await prisma.find.findMany({
      where: { huntId, playerId: player.id },
      select: { cacheId: true },
    });
    const foundCacheIds = huntFinds.map((f) => f.cacheId);
    const foundSet = new Set(foundCacheIds);

    // The teleport and cooldown checks are GLOBAL, however. Physical
    // plausibility is a property of a body, not of a hunt — scoped per-hunt, a
    // player in two hunts alternates between them and never trips either
    // check. `Find` carries @@index([playerId, foundAt]) for exactly this
    // query.
    const lastFind = await prisma.find.findFirst({
      where: { playerId: player.id },
      orderBy: { foundAt: "desc" },
      select: { lat: true, lng: true, foundAt: true },
    });

    const unfoundCaches: HuntCache[] = hunt.caches
      .filter((c) => !foundSet.has(c.id))
      .map((c) => ({
        id: c.id,
        lat: c.lat,
        lng: c.lng,
        radiusMeters: c.radiusMeters,
        // Decimal -> bigint at the boundary. Never Number(): 1e18 does not
        // survive a double, and the loss is silent.
        rewardCreditWei: toWei(c.rewardCreditWei),
      }));

    const result = validateClaim({
      attempt: {
        lat: input.lat,
        lng: input.lng,
        accuracyM: input.accuracyM,
        clientTs,
      },
      serverNow,
      playerId: player.id,
      playerActive: player.active && player.suspendedAt === null,
      huntActive: hunt.active,
      huntStartsAt: hunt.startsAt,
      huntEndsAt: hunt.endsAt,
      unfoundCaches,
      foundCacheIds,
      lastFind,
      rules: {
        maxAccuracyM: hunt.maxAccuracyM,
        maxSpeedKmh: hunt.maxSpeedKmh,
        cooldownSeconds: hunt.cooldownSeconds,
        maxClockSkewSeconds: hunt.maxClockSkewSeconds,
      },
    });

    // A rejection the verifier decided: log it with its real reason, answer
    // with the opaque one. `detail` names distances and thresholds, which is
    // precisely the oracle the whole design is avoiding, so it never leaves
    // the server.
    if (!result.ok) {
      await prisma.claimAttempt.create({
        data: {
          huntId,
          playerId: player.id,
          clientTs,
          lat: input.lat,
          lng: input.lng,
          accuracyM: input.accuracyM,
          kind: "cache",
          accepted: false,
          reason: result.reason,
          detail: result.detail,
          flagged: result.flagged,
        },
      });
      return NextResponse.json(clientRejectBody(result.reason), {
        status: 200,
      });
    }

    const reward = result.rewardCreditWei;
    // Decimal(78, 0) columns take a string; the DB itself then rejects "0.5",
    // "1e18" and "abc" at write time.
    const rewardParam = fromWei(reward);
    const cache = hunt.caches.find((c) => c.id === result.cacheId)!;

    // --- Commit ------------------------------------------------------------
    // ONE transaction: both ceilings, the Find, the ledger, the balance and
    // the audit row. Everything that used to sit outside it was a TOCTOU hole
    // — the budget sum and the per-player count were read before the write, so
    // K concurrent claims all observed the same totals, all passed, and the
    // hunt overspent by (K-1) rewards. There is no read-then-write left here:
    // each ceiling is a conditional UPDATE whose affected-row count decides.
    try {
      // The BACKSTOP, not the fix. Consistent lock ordering is what removes
      // the cycle; this catches whatever contends next — a ceiling added out
      // of order, a deadlock from a route that does not exist yet. Retrying is
      // safe only because the unit is a transaction: an aborted one committed
      // nothing, so running it again runs it for the first time.
      const committed = await withTransactionRetry(
        () =>
          prisma.$transaction(async (tx) => {
            // The counter row has to exist before a conditional UPDATE can hit it.
            // Creating it grants nothing on its own — findCount starts at 0.
            //
            // ON CONFLICT DO NOTHING, not prisma.upsert: a compound-key upsert is
            // a read-then-insert, so two first-time claims by the same player race
            // and one takes a unique violation on the primary key. Inside a
            // Postgres transaction that violation aborts EVERYTHING, and the
            // route's P2002 handler would then file the attempt as
            // "already_found" — a legitimate find refused, and an audit row that
            // says something that never happened.
            await tx.$executeRaw`
          INSERT INTO "PlayerHunt" ("huntId", "playerId")
          VALUES (${huntId}, ${player.id})
          ON CONFLICT ("huntId", "playerId") DO NOTHING`;

            // CEILING 1 — per-player find cap. `maxFindsPerPlayer = 0` disables
            // it, matching the schema default. The comparison happens in the
            // database against the row's current value, so two concurrent claims
            // cannot both see findCount = N.
            //
            // lastVerified* is set here and only here: it is the last position the
            // VERIFIER accepted, and spawns are placed relative to it precisely so
            // a spoofer cannot summon one by asserting a position.
            const capped = await tx.$executeRaw`
          UPDATE "PlayerHunt"
             SET "findCount" = "findCount" + 1,
                 "earnedCreditWei" = "earnedCreditWei" + ${rewardParam}::numeric,
                 "firstFindAt" = COALESCE("firstFindAt", ${serverNow}),
                 "lastFindAt" = ${serverNow},
                 "lastVerifiedLat" = ${input.lat},
                 "lastVerifiedLng" = ${input.lng},
                 "lastVerifiedAt" = ${serverNow}
           WHERE "huntId" = ${huntId}
             AND "playerId" = ${player.id}
             AND (${hunt.maxFindsPerPlayer} = 0
                  OR "findCount" + 1 <= ${hunt.maxFindsPerPlayer})`;
            if (capped === 0) throw new CeilingRejected("player_cap_reached");

            // CEILING 2 — hunt credit budget. Same CAS shape.
            //
            // ORDER IS LOAD-BEARING, and the reason is no longer just "cheapest
            // refusal first". The Hunt row is the one row EVERY claim and EVERY
            // collect in this hunt must touch; PlayerHunt rows are per-player. So
            // Hunt is taken LAST, deliberately, to hold the global lock for the
            // shortest possible window — and the spawn collect route was changed
            // to match, because it used to take these two in the opposite order.
            // Two shared rows in opposite orders is the textbook deadlock, and it
            // was killing roughly 0.7% of claims with an HTTP 500 whenever
            // Postgres picked the claim as the victim.
            //
            // Any future ceiling touching both rows takes PlayerHunt first.
            const funded = await tx.$executeRaw`
          UPDATE "Hunt"
             SET "spentCreditWei" = "spentCreditWei" + ${rewardParam}::numeric,
                 "updatedAt" = NOW()
           WHERE "id" = ${huntId}
             AND ("budgetCreditWei" = 0
                  OR "spentCreditWei" + ${rewardParam}::numeric <= "budgetCreditWei")`;
            if (funded === 0)
              throw new CeilingRejected("hunt_budget_exhausted");

            // The find itself. @@unique([cacheId, playerId]) is what makes a
            // double-claim structurally impossible rather than merely unlikely; a
            // racing duplicate lands here as P2002 and rolls back both ceilings.
            const find = await tx.find.create({
              data: {
                huntId,
                cacheId: result.cacheId,
                playerId: player.id,
                foundAt: serverNow,
                distanceMeters: result.distanceMeters,
                accuracyM: result.accuracyM,
                lat: input.lat,
                lng: input.lng,
                speedKmhFromLast: result.speedKmh,
                // Snapshotted so a later edit to Cache.rewardCreditWei cannot
                // retroactively change what this find was worth.
                rewardCreditSnapshot: rewardParam,
              },
            });

            // TURBO credit. No Payout — a find never moves native MON; Payout is
            // spawn-only now. The balance is incremented by the database, and the
            // ledger row records the balance that increment produced, so ledger
            // and balance can be reconciled against each other later.
            let balanceAfterWei: bigint | null = null;
            if (reward > 0n) {
              const updatedPlayer = await tx.player.update({
                where: { id: player.id },
                data: { creditBalanceWei: { increment: rewardParam } },
                select: { creditBalanceWei: true },
              });
              // The balance the DB actually produced, worked backwards to the
              // before-value so the pure helper — including its refusal to issue
              // credit on top of a negative balance — sees the real numbers.
              const balanceAfter = toWei(updatedPlayer.creditBalanceWei);
              const entry = creditForFind(balanceAfter - reward, reward);
              if (!entry) {
                throw new Error("no credit entry for a positive reward");
              }
              balanceAfterWei = entry.balanceAfterWei;

              await tx.creditLedger.create({
                data: {
                  playerId: player.id,
                  huntId,
                  reason: entry.reason,
                  amountWei: fromWei(entry.amountWei),
                  balanceAfterWei: fromWei(entry.balanceAfterWei),
                  // @unique — one credit entry per find, so a find is
                  // structurally incapable of issuing credit twice.
                  findId: find.id,
                },
              });
            }

            // The audit row, with the FINAL outcome, in the SAME transaction as
            // the find it describes. Written before the ceilings it used to say
            // `accepted: true` for claims that were then refused — and a human
            // reads this row when deciding whether to honour a disputed claim by
            // hand, so that was a path to paying out money the verifier declined.
            await tx.claimAttempt.create({
              data: {
                huntId,
                playerId: player.id,
                clientTs,
                lat: input.lat,
                lng: input.lng,
                accuracyM: result.accuracyM,
                kind: "cache",
                accepted: true,
                reason: null,
                detail: null,
                flagged: false,
              },
            });

            return { find, balanceAfterWei };
          }),
        {
          onRetry: (attempt, delayMs) => {
            // Contention has to be visible; a silent retry loop hides the load
            // that caused it.
            console.warn(
              `[hunt/claim] transaction retry ${attempt} for player ${player.id} after ${delayMs}ms`,
            );
          },
        },
      );

      return NextResponse.json({
        found: true,
        findId: committed.find.id,
        // The reveal — safe to send only because they are standing on it.
        cache: {
          label: cache.label,
          blurb: cache.blurb,
          photoCid: cache.photoCid,
        },
        rewardCreditWei: rewardParam,
        creditBalanceWei:
          committed.balanceAfterWei === null
            ? null
            : fromWei(committed.balanceAfterWei),
        // The player's own remaining caches in this hunt. NOT the hunt-wide
        // find count: that is other players' activity and no client needs it.
        remaining: unfoundCaches.length - 1,
      });
    } catch (e) {
      // A ceiling refused, or a racing duplicate won. Either way the
      // transaction rolled back, taking its audit row with it — so the audit
      // row for the refusal is written here, afterwards. It still states the
      // final outcome, which is the property that matters; an accept, by
      // contrast, can never exist without its audit row because they commit
      // together.
      let auditReason: RejectReason | null = null;
      let detail: string | null = null;

      if (e instanceof CeilingRejected) {
        auditReason = e.auditReason;
        detail = "atomic ceiling refused the find";
      } else if (
        typeof e === "object" &&
        e !== null &&
        "code" in e &&
        (e as { code: string }).code === "P2002"
      ) {
        // Unique violation on (cacheId, playerId) or on CreditLedger.findId —
        // two claims raced and the first one won. Not an error, and it must
        // not issue a second credit entry.
        auditReason = "already_found";
        detail = "duplicate find lost the race";
      } else if (e instanceof SerializationExhausted) {
        // Every attempt was aborted. NOTHING COMMITTED — no find, no credit,
        // no counter moved — so the cache is still there and the next claim
        // will get it. Filed like any other refusal so it cannot vanish from
        // the trail a disputed claim is answered from.
        //
        // The client still gets the OPAQUE body. A distinguishable "we were
        // busy" would be a location oracle: contention only happens inside the
        // transaction, which is only reached once the verifier has accepted —
        // so saying so would confirm a cache is there.
        auditReason = "contended";
        detail = `transaction aborted after ${e.attempts} attempts`;
        console.warn(
          `[hunt/claim] gave up after ${e.attempts} aborted attempts for player ${player.id}`,
        );
      }

      if (!auditReason) throw e;

      await prisma.claimAttempt.create({
        data: {
          huntId,
          playerId: player.id,
          clientTs,
          lat: input.lat,
          lng: input.lng,
          accuracyM: input.accuracyM,
          kind: "cache",
          accepted: false,
          reason: auditReason,
          detail,
          flagged: false,
        },
      });

      // Same opaque body as every other rejection: a budget-exhausted answer
      // that differs from a nothing-here answer tells a grid search it has
      // found a real cache.
      return NextResponse.json(clientRejectBody(auditReason), { status: 200 });
    }
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: 401 });
    }
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: "invalid payload" }, { status: 400 });
    }
    console.error("[hunt/claim]", e);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
