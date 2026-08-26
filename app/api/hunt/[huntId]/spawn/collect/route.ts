import { NextResponse } from "next/server";
import { z } from "zod";
import type { Hex } from "viem";
import { prisma } from "@/lib/db/prisma";
import {
  requirePlayer,
  verifySignedClaim,
  AuthError,
  clientIp,
} from "@/lib/auth";
import { checkLimit } from "@/lib/ratelimit";
import { toWei, fromWei } from "@/lib/wei";
import {
  validateSpawnCollect,
  deriveSeed,
  verifySeed,
  type SpawnRejectReason,
} from "@/lib/hunt/spawn";
import {
  decideAutoApproval,
  sumAutoApprovedLast24hWei,
} from "@/lib/hunt/approval";
import { withTransactionRetry, SerializationExhausted } from "@/lib/db/retry";

// Collect a spawn. This is where a debt is decided, and it is the ONLY player-
// reachable path that ends in native MON leaving the treasury.
//
// It does not send anything. It writes a Payout, and /api/cron/payouts sends
// it after approval — because the send must not happen inside the transaction
// that decides whether it was earned. A broadcast cannot be rolled back when
// the transaction it sits in aborts.
//
// The controls, in the order they run:
//
//   1. auth, then rate limit, then EIP-712 signature. The signature is what
//      makes the attempt non-repudiable and removes the stolen-cookie path.
//   2. validateSpawnCollect — the SAME accuracy, clock-skew, cooldown and
//      speed checks a cache claim gets, against the same Hunt columns. A
//      spawn must not be an easier door into the treasury than a cache is.
//   3. ONE transaction containing every ceiling as an atomic conditional
//      UPDATE with a checked row count:
//        a. single-collector CAS on the Spawn row
//        b. hunt MON budget
//        c. per-player rolling 24h MON cap
//      plus the Payout and the ClaimAttempt that records the final outcome.
//   4. auto-approval policy, bounded and recorded in Payout.autoApproved.
//
// Rejections here return their REAL reason, unlike the claim route's single
// opaque string. That asymmetry is deliberate: the claim route is a location
// oracle because cache coordinates are secret, and a spawn's coordinates are
// published to the player who owns it. There is no secret left to leak.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Plain decimal, signed, no exponent — the exact string that was signed. */
const DECIMAL = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;

// lat/lng/accuracy arrive as STRINGS because those are the bytes the player
// signed. Re-serialising a JSON number back into the signed message is where
// canonicalisation bugs live (1.10 vs 1.1, -0, 1e-7), and each one is a valid
// signature that fails to verify.
const CollectInput = z.object({
  spawnId: z.string().min(1).max(64),
  lat: z.string().regex(DECIMAL),
  lng: z.string().regex(DECIMAL),
  accuracyM: z.string().regex(DECIMAL),
  /** Unix SECONDS, matching the EIP-712 ClaimAttempt struct. */
  clientTs: z.number().int().nonnegative(),
  nonce: z.string().min(1).max(128),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130,}$/),
});

/** Thrown inside the commit transaction so the audit row states the FINAL
 *  outcome rather than the outcome the verifier alone predicted. */
class CollectRejected extends Error {
  constructor(readonly auditReason: SpawnRejectReason) {
    super(auditReason);
    this.name = "CollectRejected";
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ huntId: string }> },
) {
  const { huntId } = await params;

  try {
    const player = await requirePlayer(req);

    const limit = await checkLimit("spawn", {
      playerId: player.id,
      ip: clientIp(req),
    });
    if (!limit.ok) {
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

    const input = CollectInput.parse(await req.json());

    // Non-repudiation before anything is decided. verifySignedClaim throws
    // AuthError on a bad signature, a replayed nonce or a stale timestamp.
    await verifySignedClaim({
      huntId,
      lat: input.lat,
      lng: input.lng,
      accuracyM: input.accuracyM,
      clientTs: BigInt(input.clientTs),
      nonce: input.nonce,
      signature: input.signature as Hex,
      expectedAddress: player.walletAddress,
    });

    const lat = Number(input.lat);
    const lng = Number(input.lng);
    const accuracyM = Number(input.accuracyM);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      !Number.isFinite(accuracyM) ||
      !(lat >= -90 && lat <= 90) ||
      !(lng >= -180 && lng <= 180) ||
      !(accuracyM >= 0)
    ) {
      return NextResponse.json({ error: "invalid payload" }, { status: 400 });
    }

    const now = new Date();
    const clientTs = new Date(input.clientTs * 1000);

    const hunt = await prisma.hunt.findUnique({ where: { id: huntId } });
    if (!hunt) {
      return NextResponse.json({ error: "hunt not found" }, { status: 404 });
    }

    const spawn = await prisma.spawn.findFirst({
      where: { id: input.spawnId, huntId },
    });

    // Movement plausibility is a property of a body, not of a hunt: the
    // previous accepted position is the most recent of ANY hunt's find or
    // collect. Scoped per-hunt, a player in two hunts alternates between them
    // and never trips the cooldown or the speed check.
    const [lastFind, lastCollected] = await Promise.all([
      prisma.find.findFirst({
        where: { playerId: player.id },
        orderBy: { foundAt: "desc" },
        select: { lat: true, lng: true, foundAt: true },
      }),
      prisma.spawn.findFirst({
        where: { playerId: player.id, collectedAt: { not: null } },
        orderBy: { collectedAt: "desc" },
        select: { lat: true, lng: true, collectedAt: true },
      }),
    ]);

    const candidates = [
      lastFind && {
        lat: lastFind.lat,
        lng: lastFind.lng,
        at: lastFind.foundAt,
      },
      lastCollected?.collectedAt && {
        lat: lastCollected.lat,
        lng: lastCollected.lng,
        at: lastCollected.collectedAt,
      },
    ].filter((c): c is { lat: number; lng: number; at: Date } => Boolean(c));
    const lastAccepted =
      candidates.length === 0
        ? null
        : candidates.reduce((a, b) => (a.at > b.at ? a : b));

    const result = validateSpawnCollect({
      attempt: { lat, lng, accuracyM, clientTs },
      serverNow: now,
      playerId: player.id,
      playerActive: player.active && player.suspendedAt === null,
      huntActive: hunt.active,
      huntStartsAt: hunt.startsAt,
      huntEndsAt: hunt.endsAt,
      spawn: spawn
        ? {
            id: spawn.id,
            playerId: spawn.playerId,
            lat: spawn.lat,
            lng: spawn.lng,
            radiusMeters: spawn.radiusMeters,
            expiresAt: spawn.expiresAt,
            collectedAt: spawn.collectedAt,
          }
        : null,
      lastAccepted,
      rules: {
        maxAccuracyM: hunt.maxAccuracyM,
        maxSpeedKmh: hunt.maxSpeedKmh,
        cooldownSeconds: hunt.cooldownSeconds,
        maxClockSkewSeconds: hunt.maxClockSkewSeconds,
      },
    });

    if (!result.ok) {
      await prisma.claimAttempt.create({
        data: {
          huntId,
          playerId: player.id,
          clientTs,
          lat,
          lng,
          accuracyM,
          kind: "spawn",
          accepted: false,
          reason: result.reason,
          detail: result.detail,
          flagged: result.flagged,
        },
      });
      return NextResponse.json({ collected: false, reason: result.reason });
    }

    // `spawn` is non-null here — validateSpawnCollect rejects a null one — but
    // the compiler does not know that.
    if (!spawn) {
      return NextResponse.json({ error: "internal error" }, { status: 500 });
    }

    const amount = toWei(spawn.amountMonWei);
    const amountParam = fromWei(amount);

    // The reveal half of the commitment. If the recomputed seed does not match
    // what was published, the secret has been rotated or the row was tampered
    // with — fail loudly and pay nothing rather than reveal a seed that does
    // not open the commitment.
    const seedSecret = process.env.SPAWN_SEED_SECRET;
    if (!seedSecret) {
      console.error("[hunt/spawn/collect] SPAWN_SEED_SECRET is not set");
      return NextResponse.json(
        { error: "spawns are not configured" },
        { status: 503 },
      );
    }
    const seed = deriveSeed(seedSecret, spawn.id);
    if (!verifySeed(seed, spawn.seedCommit)) {
      console.error(
        "[hunt/spawn/collect] seed does not open the published commitment",
        spawn.id,
      );
      return NextResponse.json(
        { error: "spawn cannot be verified" },
        { status: 503 },
      );
    }

    // --- Commit -------------------------------------------------------------
    // Serializable, because the auto-approval daily cap is a SUM over rows this
    // transaction is also inserting into. Under READ COMMITTED two concurrent
    // collects each read a total that excludes the other and both auto-approve;
    // Serializable turns that into a serialization failure instead of an
    // overshoot. The three hard ceilings below do not rely on it — they are
    // conditional UPDATEs and would hold at any isolation level.
    try {
      // RETRIED AS A WHOLE, because the unit is a transaction: an aborted one
      // committed nothing, so running it again is running it for the first
      // time. Serializable (below) converts a concurrent overshoot into an
      // abort, and this is what converts the abort into an answer. Without it
      // a collect that merely lost a scheduling race returned HTTP 500 and
      // wrote no ClaimAttempt row -- measured at seven in ten under ten-way
      // contention.
      //
      // The bound matters as much as the retry, and these numbers are measured
      // rather than picked. Against ten genuinely simultaneous collects:
      //
      //   no retry   3 collected, 7 x HTTP 500, no audit rows
      //   4 attempts 6-7 collected, 3-4 told "contended", no 500s
      //   6 attempts 10 collected, 0 contended, across every run
      //
      // Six it is, capped at 150ms per sleep: worst case ~440ms of added
      // latency, average around half that under full jitter. Waiting a beat
      // beats telling someone standing at the spawn to tap it again. It still
      // GIVES UP rather than looping, because an unbounded retry trades an
      // opaque error for a pile of held connections, which is the worse
      // outage.
      const committed = await withTransactionRetry(
        () =>
          prisma.$transaction(
            async (tx) => {
              // CEILING 1 — single collector. The whole race, decided by one
              // statement: whoever's UPDATE affects a row owns the spawn. A
              // read-then-write here pays every concurrent caller.
              const claimed = await tx.$executeRaw`
            UPDATE "Spawn"
               SET "collectedAt" = ${now},
                   "seedReveal" = ${seed}
             WHERE "id" = ${spawn.id}
               AND "playerId" = ${player.id}
               AND "collectedAt" IS NULL
               AND "expiresAt" > ${now}::timestamptz`;
              if (claimed === 0) {
                throw new CollectRejected("spawn_already_collected");
              }

              // CEILING 2 — hunt MON budget. Note `budgetMonWei > 0` is REQUIRED,
              // not "0 disables": this is real money leaving a hot wallet, so an
              // unconfigured hunt must pay nothing. (Credit, which is a discount
              // rather than cash, reads 0 as disabled — deliberately different.)
              const funded = await tx.$executeRaw`
            UPDATE "Hunt"
               SET "spentMonWei" = "spentMonWei" + ${amountParam}::numeric,
                   "updatedAt" = NOW()
             WHERE "id" = ${huntId}
               AND "budgetMonWei" > 0
               AND "spentMonWei" + ${amountParam}::numeric <= "budgetMonWei"`;
              if (funded === 0)
                throw new CollectRejected("hunt_budget_exhausted");

              // CEILING 3 — per-player rolling 24h cap, measured over the Spawn
              // rows themselves (the row collected above is already inside this
              // transaction's view, so it counts). Also the place the accepted
              // position is recorded: a collect is a verified fix, so it becomes
              // the anchor for the next spawn.
              const capped = await tx.$executeRaw`
            UPDATE "PlayerHunt"
               SET "collectedMonWei" = "collectedMonWei" + ${amountParam}::numeric,
                   "lastVerifiedLat" = ${lat},
                   "lastVerifiedLng" = ${lng},
                   "lastVerifiedAt" = ${now}
             WHERE "huntId" = ${huntId}
               AND "playerId" = ${player.id}
               AND ${amountParam}::numeric > 0
               AND (SELECT "spawnDailyCapWeiPerPlayer" FROM "Hunt" WHERE "id" = ${huntId}) > 0
               AND COALESCE((
                     SELECT SUM(s."amountMonWei")
                       FROM "Spawn" s
                      WHERE s."playerId" = ${player.id}
                        AND s."huntId" = ${huntId}
                        AND s."collectedAt" > ${now}::timestamptz - make_interval(hours => 24)
                   ), 0)
                   <= (SELECT "spawnDailyCapWeiPerPlayer" FROM "Hunt" WHERE "id" = ${huntId})`;
              if (capped === 0) {
                throw new CollectRejected("player_daily_cap_reached");
              }

              // --- Approval policy ------------------------------------------
              // A flagged attempt never auto-approves. "Flagged" is read wider than
              // this one attempt: a player with a flagged attempt in the last 24h
              // is a player a person should look at before money moves, even if
              // this particular collect was clean.
              const recentFlagged = await tx.claimAttempt.count({
                where: {
                  playerId: player.id,
                  flagged: true,
                  attemptedAt: { gte: new Date(now.getTime() - 86_400_000) },
                },
              });

              const decision = decideAutoApproval({
                amountWei: amount,
                autoApproveMaxWei: toWei(hunt.autoApproveMaxWei),
                autoApproveDailyCapWei: toWei(hunt.autoApproveDailyCapWei),
                autoApprovedLast24hWei: await sumAutoApprovedLast24hWei(
                  huntId,
                  now,
                  tx,
                ),
                attemptFlagged: recentFlagged > 0,
                playerSuspended: player.suspendedAt !== null,
                playerActive: player.active,
              });

              // One payout per spawn — @unique on spawnId is what makes paying the
              // same collect twice structurally impossible.
              const payout = await tx.payout.create({
                data: {
                  spawnId: spawn.id,
                  playerId: player.id,
                  amountMonWei: amountParam,
                  status: decision.autoApprove ? "APPROVED" : "PENDING",
                  autoApproved: decision.autoApprove,
                  // Left null on purpose when nobody approved it: `autoApproved`
                  // plus a null `approvedBy` is what the audit reads as "released
                  // by policy".
                  approvedBy: null,
                  approvedAt: decision.autoApprove ? now : null,
                },
              });

              await tx.claimAttempt.create({
                data: {
                  huntId,
                  playerId: player.id,
                  clientTs,
                  lat,
                  lng,
                  accuracyM,
                  kind: "spawn",
                  accepted: true,
                  reason: null,
                  detail: null,
                  flagged: false,
                },
              });

              return { payout, decision };
            },
            { isolationLevel: "Serializable" },
          ),
        {
          attempts: 6,
          maxDelayMs: 150,
          onRetry: (attempt, delayMs) => {
            // Contention has to be visible: a silent retry loop hides the load
            // that caused it, and this is the signal that says the collect
            // path is at its limit before players start seeing "contended".
            console.warn(
              `[hunt/spawn/collect] serialization retry ${attempt} for player ${player.id} after ${delayMs}ms`,
            );
          },
        },
      );

      return NextResponse.json({
        collected: true,
        spawnId: spawn.id,
        amountMonWei: amountParam,
        // The reveal: sha256(seedReveal) === seedCommit, and re-running
        // deriveSpawn on it reproduces this exact position and amount.
        seedReveal: seed,
        payout: {
          id: committed.payout.id,
          status: committed.payout.status,
          autoApproved: committed.decision.autoApprove,
          // Honest about the wait. Nothing is on chain yet.
          holdReason: committed.decision.autoApprove
            ? null
            : committed.decision.reason,
        },
      });
    } catch (e) {
      let auditReason: SpawnRejectReason | null = null;
      let detail: string | null = null;

      if (e instanceof CollectRejected) {
        auditReason = e.auditReason;
        detail = "atomic ceiling refused the collect";
      } else if (
        typeof e === "object" &&
        e !== null &&
        "code" in e &&
        (e as { code: string }).code === "P2002"
      ) {
        // Payout.spawnId is unique: a racing duplicate lost. Not an error, and
        // it must not create a second payout.
        auditReason = "spawn_already_collected";
        detail = "duplicate collect lost the race";
      } else if (e instanceof SerializationExhausted) {
        // Every attempt was aborted by Postgres. NOTHING COMMITTED -- no
        // payout, no counter moved, the spawn still uncollected -- so this is a
        // transient refusal, not a loss. It is filed like any other refusal
        // precisely because it must not vanish from the trail a disputed
        // payout is answered from.
        auditReason = "contended";
        detail = `serialization failed after ${e.attempts} attempts`;
        console.warn(
          `[hunt/spawn/collect] gave up after ${e.attempts} serialization failures for player ${player.id}`,
        );
      }

      if (!auditReason) throw e;

      await prisma.claimAttempt.create({
        data: {
          huntId,
          playerId: player.id,
          clientTs,
          lat,
          lng,
          accuracyM,
          kind: "spawn",
          accepted: false,
          reason: auditReason,
          detail,
          flagged: false,
        },
      });

      return NextResponse.json({ collected: false, reason: auditReason });
    }
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: 401 });
    }
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: "invalid payload" }, { status: 400 });
    }
    console.error("[hunt/spawn/collect]", e);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
