// Read models for the operator console.
//
// Query discipline, because these tables grow without bound:
//   * every list is paginated and every aggregate is bounded by a time window
//     or a status set;
//   * status filters are written as `status: { in: [...] }` even when that
//     means listing all seven values, because the composite index is
//     `(status, createdAt)` — a bare createdAt range cannot use it and
//     degenerates into a sequential scan of the whole Payout table;
//   * per-player lookups are keyed on (playerId, attemptedAt) /
//     (playerId, foundAt), which are indexed, and always carry a `take`.
//
// Cache lat/lng appear ONLY in `listCaches`, which is called from the
// OPERATOR-gated cache management screen. No other function here selects them.

import { PayoutStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { haversineMeters } from "@/lib/geo/distance";
import { signedWei, sumWei, weiOf } from "@/lib/admin/format";
import type { PageSpec } from "@/lib/admin/pagination";

const ALL_STATUSES: PayoutStatus[] = [
  PayoutStatus.PENDING,
  PayoutStatus.APPROVED,
  PayoutStatus.SENDING,
  PayoutStatus.SENT,
  PayoutStatus.FAILED,
  PayoutStatus.NEEDS_RECONCILIATION,
  PayoutStatus.VOIDED,
];

// Statuses where MON is owed but has not (verifiably) left the treasury.
export const LIABILITY_STATUSES: PayoutStatus[] = [
  PayoutStatus.PENDING,
  PayoutStatus.APPROVED,
];

// Statuses where the money may already be gone but is not confirmed. Shown
// separately on the treasury screen — netting these against the balance would
// hide the worst case.
export const IN_FLIGHT_STATUSES: PayoutStatus[] = [
  PayoutStatus.SENDING,
  PayoutStatus.NEEDS_RECONCILIATION,
];

// ---------------------------------------------------------------------------
// Payout review queue
// ---------------------------------------------------------------------------

export interface PayoutReviewRow {
  id: string;
  status: PayoutStatus;
  amountWei: bigint;
  autoApproved: boolean;
  approvedBy: string | null;
  approvedAt: Date | null;
  createdAt: Date;
  txHash: string | null;
  failReason: string | null;
  voidReason: string | null;
  reconciledBy: string | null;

  // The verifier thresholds this attempt was judged against, so the queue can
  // show "112 km/h" next to "limit 60" instead of a number with no scale.
  hunt: {
    id: string;
    name: string;
    maxSpeedKmh: number;
    maxAccuracyM: number;
  };
  spawn: {
    id: string;
    lat: number;
    lng: number;
    radiusMeters: number;
    createdAt: Date;
    expiresAt: Date;
    collectedAt: Date | null;
    seedCommit: string;
    seedReveal: string | null;
  };
  player: {
    id: string;
    walletAddress: string;
    turboUsername: string | null;
    displayName: string | null;
    suspendedAt: Date | null;
    active: boolean;
    createdAt: Date;
  };

  /** The collect attempt this payout came from, matched by time. */
  attempt: {
    id: string;
    attemptedAt: Date;
    clientTs: Date;
    lat: number;
    lng: number;
    accuracyM: number | null;
    accepted: boolean;
    flagged: boolean;
    reason: string | null;
  } | null;

  /** Movement plausibility: how fast they got here from their last find. */
  previousFindAt: Date | null;
  distanceSincePreviousFindM: number | null;
  speedKmhSincePreviousFind: number | null;

  /** Player history the operator needs to judge this in context. */
  history: {
    findsInHunt: number;
    collectedMonWeiInHunt: bigint;
    flaggedAttempts30d: number;
    payoutsSent: number;
    payoutsVoided: number;
  };
}

interface PayoutQueueParams {
  statuses: PayoutStatus[];
  huntId?: string;
  page: PageSpec;
}

export async function listPayoutReview(
  params: PayoutQueueParams,
): Promise<{ rows: PayoutReviewRow[]; total: number }> {
  const where: Prisma.PayoutWhereInput = {
    status: { in: params.statuses },
    ...(params.huntId ? { spawn: { huntId: params.huntId } } : {}),
  };

  const [total, payouts] = await Promise.all([
    prisma.payout.count({ where }),
    prisma.payout.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: params.page.skip,
      take: params.page.take,
      include: {
        spawn: {
          include: {
            hunt: {
              select: {
                id: true,
                name: true,
                maxSpeedKmh: true,
                maxAccuracyM: true,
              },
            },
          },
        },
        player: {
          select: {
            id: true,
            walletAddress: true,
            turboUsername: true,
            displayName: true,
            suspendedAt: true,
            active: true,
            createdAt: true,
          },
        },
      },
    }),
  ]);

  if (payouts.length === 0) return { rows: [], total };

  const playerIds = [...new Set(payouts.map((p) => p.playerId))];

  // Anchor times for the attempt match: a collect writes its ClaimAttempt in
  // the same request that flips Spawn.collectedAt, so a couple of minutes of
  // slack around it is generous.
  const anchors = payouts.map((p) => p.spawn.collectedAt ?? p.createdAt);
  const windowMs = 3 * 60 * 1000;
  const from = new Date(
    Math.min(...anchors.map((d) => d.getTime())) - windowMs,
  );
  const to = new Date(Math.max(...anchors.map((d) => d.getTime())) + windowMs);

  const [attempts, playerHunts, flaggedCounts, payoutCounts, recentFinds] =
    await Promise.all([
      prisma.claimAttempt.findMany({
        where: {
          playerId: { in: playerIds },
          kind: "spawn",
          attemptedAt: { gte: from, lte: to },
        },
        orderBy: { attemptedAt: "desc" },
        take: 1000,
        select: {
          id: true,
          playerId: true,
          huntId: true,
          attemptedAt: true,
          clientTs: true,
          lat: true,
          lng: true,
          accuracyM: true,
          accepted: true,
          flagged: true,
          reason: true,
        },
      }),
      prisma.playerHunt.findMany({
        where: { playerId: { in: playerIds } },
        select: {
          playerId: true,
          huntId: true,
          findCount: true,
          collectedMonWei: true,
        },
      }),
      prisma.claimAttempt.groupBy({
        by: ["playerId"],
        where: {
          playerId: { in: playerIds },
          flagged: true,
          attemptedAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
        },
        _count: { _all: true },
      }),
      prisma.payout.groupBy({
        by: ["playerId", "status"],
        where: { playerId: { in: playerIds }, status: { in: ALL_STATUSES } },
        _count: { _all: true },
      }),
      // Bounded per player rather than one big take, so a single prolific
      // player cannot crowd everyone else out of the result set.
      Promise.all(
        playerIds.map((playerId) =>
          prisma.find.findMany({
            where: { playerId },
            orderBy: { foundAt: "desc" },
            take: 5,
            select: { playerId: true, foundAt: true, lat: true, lng: true },
          }),
        ),
      ).then((r) => r.flat()),
    ]);

  const flaggedByPlayer = new Map(
    flaggedCounts.map((c) => [c.playerId, c._count._all]),
  );
  const huntStats = new Map(
    playerHunts.map((s) => [`${s.playerId}:${s.huntId}`, s]),
  );
  const sentByPlayer = new Map<string, number>();
  const voidedByPlayer = new Map<string, number>();
  for (const c of payoutCounts) {
    if (c.status === PayoutStatus.SENT) {
      sentByPlayer.set(c.playerId, c._count._all);
    } else if (c.status === PayoutStatus.VOIDED) {
      voidedByPlayer.set(c.playerId, c._count._all);
    }
  }

  const rows: PayoutReviewRow[] = payouts.map((p) => {
    const anchor = p.spawn.collectedAt ?? p.createdAt;

    // Nearest spawn attempt in time for this player and hunt.
    let attempt: (typeof attempts)[number] | null = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const a of attempts) {
      if (a.playerId !== p.playerId || a.huntId !== p.spawn.huntId) continue;
      const delta = Math.abs(a.attemptedAt.getTime() - anchor.getTime());
      if (delta < bestDelta) {
        bestDelta = delta;
        attempt = a;
      }
    }

    // Movement plausibility. Prefer the position the player reported at
    // collect; fall back to the spawn itself, which they had to reach.
    const here = attempt
      ? { lat: attempt.lat, lng: attempt.lng }
      : { lat: p.spawn.lat, lng: p.spawn.lng };
    const priors = recentFinds
      .filter((f) => f.playerId === p.playerId && f.foundAt <= anchor)
      .sort((a, b) => b.foundAt.getTime() - a.foundAt.getTime());
    const prior = priors[0] ?? null;

    let distanceM: number | null = null;
    let speedKmh: number | null = null;
    if (prior) {
      distanceM = haversineMeters(prior, here);
      const seconds = (anchor.getTime() - prior.foundAt.getTime()) / 1000;
      // `> 0` rather than `!== 0` so a zero or negative interval yields null
      // instead of Infinity dressed up as a speed reading.
      if (seconds > 0) speedKmh = (distanceM / seconds) * 3.6;
    }

    const stats = huntStats.get(`${p.playerId}:${p.spawn.huntId}`);

    return {
      id: p.id,
      status: p.status,
      amountWei: weiOf(p.amountMonWei),
      autoApproved: p.autoApproved,
      approvedBy: p.approvedBy,
      approvedAt: p.approvedAt,
      createdAt: p.createdAt,
      txHash: p.txHash,
      failReason: p.failReason,
      voidReason: p.voidReason,
      reconciledBy: p.reconciledBy,
      hunt: p.spawn.hunt,
      spawn: {
        id: p.spawn.id,
        lat: p.spawn.lat,
        lng: p.spawn.lng,
        radiusMeters: p.spawn.radiusMeters,
        createdAt: p.spawn.createdAt,
        expiresAt: p.spawn.expiresAt,
        collectedAt: p.spawn.collectedAt,
        seedCommit: p.spawn.seedCommit,
        seedReveal: p.spawn.seedReveal,
      },
      player: p.player,
      attempt: attempt
        ? {
            id: attempt.id,
            attemptedAt: attempt.attemptedAt,
            clientTs: attempt.clientTs,
            lat: attempt.lat,
            lng: attempt.lng,
            accuracyM: attempt.accuracyM,
            accepted: attempt.accepted,
            flagged: attempt.flagged,
            reason: attempt.reason,
          }
        : null,
      previousFindAt: prior?.foundAt ?? null,
      distanceSincePreviousFindM: distanceM,
      speedKmhSincePreviousFind: speedKmh,
      history: {
        findsInHunt: stats?.findCount ?? 0,
        collectedMonWeiInHunt: stats ? weiOf(stats.collectedMonWei) : 0n,
        flaggedAttempts30d: flaggedByPlayer.get(p.playerId) ?? 0,
        payoutsSent: sentByPlayer.get(p.playerId) ?? 0,
        payoutsVoided: voidedByPlayer.get(p.playerId) ?? 0,
      },
    };
  });

  return { rows, total };
}

/** Counts per status, for the queue's filter chips. One grouped query. */
export async function payoutStatusCounts(): Promise<
  Record<PayoutStatus, number>
> {
  const grouped = await prisma.payout.groupBy({
    by: ["status"],
    where: { status: { in: ALL_STATUSES } },
    _count: { _all: true },
  });
  const out = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<
    PayoutStatus,
    number
  >;
  for (const g of grouped) out[g.status] = g._count._all;
  return out;
}

// ---------------------------------------------------------------------------
// Treasury
// ---------------------------------------------------------------------------

export interface HuntBudgetRow {
  id: string;
  name: string;
  active: boolean;
  spawnEnabled: boolean;
  budgetMonWei: bigint;
  spentMonWei: bigint;
  budgetCreditWei: bigint;
  spentCreditWei: bigint;
  autoApproveMaxWei: bigint;
  autoApproveDailyCapWei: bigint;
  autoApproved24hWei: bigint;
}

export interface TreasurySnapshot {
  pendingWei: bigint;
  pendingCount: number;
  approvedWei: bigint;
  approvedCount: number;
  inFlightWei: bigint;
  inFlightCount: number;
  needsReconciliationCount: number;
  sent24hWei: bigint;
  autoApproved24hWei: bigint;
  autoApprovedAllTimeWei: bigint;
  creditIssuedWei: bigint;
  creditOutstandingWei: bigint;
  hunts: HuntBudgetRow[];
}

export async function treasurySnapshot(): Promise<TreasurySnapshot> {
  const since24h = new Date(Date.now() - 24 * 3_600_000);

  const [
    pending,
    approved,
    inFlight,
    needsRecon,
    sent24h,
    auto24h,
    autoAll,
    creditIssued,
    creditBalances,
    hunts,
    autoByHunt,
  ] = await Promise.all([
    prisma.payout.aggregate({
      where: { status: { in: [PayoutStatus.PENDING] } },
      _sum: { amountMonWei: true },
      _count: { _all: true },
    }),
    prisma.payout.aggregate({
      where: { status: { in: [PayoutStatus.APPROVED] } },
      _sum: { amountMonWei: true },
      _count: { _all: true },
    }),
    prisma.payout.aggregate({
      where: { status: { in: IN_FLIGHT_STATUSES } },
      _sum: { amountMonWei: true },
      _count: { _all: true },
    }),
    prisma.payout.count({
      where: { status: { in: [PayoutStatus.NEEDS_RECONCILIATION] } },
    }),
    prisma.payout.aggregate({
      where: { status: { in: [PayoutStatus.SENT] }, sentAt: { gte: since24h } },
      _sum: { amountMonWei: true },
    }),
    prisma.payout.aggregate({
      where: {
        status: { in: ALL_STATUSES },
        autoApproved: true,
        createdAt: { gte: since24h },
      },
      _sum: { amountMonWei: true },
    }),
    prisma.payout.aggregate({
      where: { status: { in: ALL_STATUSES }, autoApproved: true },
      _sum: { amountMonWei: true },
    }),
    prisma.creditLedger.aggregate({
      where: { amountWei: { gt: 0 } },
      _sum: { amountWei: true },
    }),
    prisma.player.aggregate({ _sum: { creditBalanceWei: true } }),
    prisma.hunt.findMany({
      orderBy: [{ active: "desc" }, { createdAt: "desc" }],
      take: 100,
      select: {
        id: true,
        name: true,
        active: true,
        spawnEnabled: true,
        budgetMonWei: true,
        spentMonWei: true,
        budgetCreditWei: true,
        spentCreditWei: true,
        autoApproveMaxWei: true,
        autoApproveDailyCapWei: true,
      },
    }),
    // Auto-approved MON in the last 24h, per hunt. Grouping on the Spawn side
    // because Payout has no huntId of its own.
    prisma.spawn.findMany({
      where: {
        payout: {
          is: {
            autoApproved: true,
            createdAt: { gte: since24h },
            status: { in: ALL_STATUSES },
          },
        },
      },
      take: 5000,
      select: { huntId: true, payout: { select: { amountMonWei: true } } },
    }),
  ]);

  const auto24hByHunt = new Map<string, bigint>();
  for (const s of autoByHunt) {
    if (!s.payout) continue;
    auto24hByHunt.set(
      s.huntId,
      (auto24hByHunt.get(s.huntId) ?? 0n) + weiOf(s.payout.amountMonWei),
    );
  }

  return {
    pendingWei: sumWei(pending._sum.amountMonWei),
    pendingCount: pending._count._all,
    approvedWei: sumWei(approved._sum.amountMonWei),
    approvedCount: approved._count._all,
    inFlightWei: sumWei(inFlight._sum.amountMonWei),
    inFlightCount: inFlight._count._all,
    needsReconciliationCount: needsRecon,
    sent24hWei: sumWei(sent24h._sum.amountMonWei),
    autoApproved24hWei: sumWei(auto24h._sum.amountMonWei),
    autoApprovedAllTimeWei: sumWei(autoAll._sum.amountMonWei),
    creditIssuedWei: sumWei(creditIssued._sum.amountWei),
    creditOutstandingWei: sumWei(creditBalances._sum.creditBalanceWei),
    hunts: hunts.map((h) => ({
      id: h.id,
      name: h.name,
      active: h.active,
      spawnEnabled: h.spawnEnabled,
      budgetMonWei: weiOf(h.budgetMonWei),
      spentMonWei: weiOf(h.spentMonWei),
      budgetCreditWei: weiOf(h.budgetCreditWei),
      spentCreditWei: weiOf(h.spentCreditWei),
      autoApproveMaxWei: weiOf(h.autoApproveMaxWei),
      autoApproveDailyCapWei: weiOf(h.autoApproveDailyCapWei),
      autoApproved24hWei: auto24hByHunt.get(h.id) ?? 0n,
    })),
  };
}

// ---------------------------------------------------------------------------
// Abuse review
// ---------------------------------------------------------------------------

export interface FlaggedAttemptRow {
  id: string;
  attemptedAt: Date;
  clientTs: Date;
  kind: string;
  lat: number;
  lng: number;
  accuracyM: number | null;
  accepted: boolean;
  reason: string | null;
  detail: string | null;
  hunt: { id: string; name: string };
  player: {
    id: string;
    walletAddress: string;
    turboUsername: string | null;
    suspendedAt: Date | null;
  };
}

export async function listFlaggedAttempts(params: {
  page: PageSpec;
  huntId?: string;
}): Promise<{ rows: FlaggedAttemptRow[]; total: number }> {
  // `flagged: true` first: the (flagged, attemptedAt) index makes this a range
  // scan rather than a walk of every attempt ever recorded.
  const where: Prisma.ClaimAttemptWhereInput = {
    flagged: true,
    ...(params.huntId ? { huntId: params.huntId } : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.claimAttempt.count({ where }),
    prisma.claimAttempt.findMany({
      where,
      orderBy: { attemptedAt: "desc" },
      skip: params.page.skip,
      take: params.page.take,
      select: {
        id: true,
        attemptedAt: true,
        clientTs: true,
        kind: true,
        lat: true,
        lng: true,
        accuracyM: true,
        accepted: true,
        reason: true,
        detail: true,
        hunt: { select: { id: true, name: true } },
        player: {
          select: {
            id: true,
            walletAddress: true,
            turboUsername: true,
            suspendedAt: true,
          },
        },
      },
    }),
  ]);

  return { rows, total };
}

export interface HintPatternRow {
  playerId: string;
  walletAddress: string;
  turboUsername: string | null;
  suspendedAt: Date | null;
  probes: number;
  finds: number;
  /** Diagonal of the bounding box the probes cover, in metres. */
  spreadM: number | null;
  /** Probes per find. Null when they have never found anything — the worst case. */
  probesPerFind: number | null;
  firstProbeAt: Date | null;
  lastProbeAt: Date | null;
}

/**
 * The trilateration signature: a lot of hint probes, spread across an area,
 * producing few or no finds. A quantized distance oracle is still an oracle —
 * walk its boundaries from three directions and the cache falls out. Someone
 * genuinely searching probes a handful of times and then finds the thing.
 */
export async function hintProbePatterns(params: {
  windowDays?: number;
  minProbes?: number;
  limit?: number;
}): Promise<HintPatternRow[]> {
  const windowDays = params.windowDays ?? 7;
  const minProbes = params.minProbes ?? 20;
  const limit = Math.min(params.limit ?? 25, 100);
  const since = new Date(Date.now() - windowDays * 86_400_000);

  const grouped = await prisma.hintRequest.groupBy({
    by: ["playerId"],
    where: { createdAt: { gte: since } },
    _count: { _all: true },
    _min: { createdAt: true },
    _max: { createdAt: true },
    orderBy: { _count: { playerId: "desc" } },
    take: limit,
  });

  const suspects = grouped.filter((g) => g._count._all >= minProbes);
  if (suspects.length === 0) return [];

  const playerIds = suspects.map((g) => g.playerId);

  const [players, findCounts, probeGeo] = await Promise.all([
    prisma.player.findMany({
      where: { id: { in: playerIds } },
      select: {
        id: true,
        walletAddress: true,
        turboUsername: true,
        suspendedAt: true,
      },
    }),
    prisma.find.groupBy({
      by: ["playerId"],
      where: { playerId: { in: playerIds }, foundAt: { gte: since } },
      _count: { _all: true },
    }),
    // Bounded per player. Enough points to measure the spread without pulling
    // an unbounded slice of HintRequest into memory.
    Promise.all(
      playerIds.map(async (playerId) => ({
        playerId,
        points: await prisma.hintRequest.findMany({
          where: { playerId, createdAt: { gte: since } },
          orderBy: { createdAt: "desc" },
          take: 300,
          select: { lat: true, lng: true },
        }),
      })),
    ),
  ]);

  const playerById = new Map(players.map((p) => [p.id, p]));
  const findsById = new Map(findCounts.map((f) => [f.playerId, f._count._all]));
  const geoById = new Map(probeGeo.map((g) => [g.playerId, g.points]));

  return suspects.flatMap((g) => {
    const player = playerById.get(g.playerId);
    if (!player) return [];
    const points = geoById.get(g.playerId) ?? [];
    const finds = findsById.get(g.playerId) ?? 0;

    let spreadM: number | null = null;
    if (points.length >= 2) {
      const lats = points.map((p) => p.lat);
      const lngs = points.map((p) => p.lng);
      spreadM = haversineMeters(
        { lat: Math.min(...lats), lng: Math.min(...lngs) },
        { lat: Math.max(...lats), lng: Math.max(...lngs) },
      );
    }

    return [
      {
        playerId: g.playerId,
        walletAddress: player.walletAddress,
        turboUsername: player.turboUsername,
        suspendedAt: player.suspendedAt,
        probes: g._count._all,
        finds,
        spreadM,
        probesPerFind: finds > 0 ? g._count._all / finds : null,
        firstProbeAt: g._min.createdAt,
        lastProbeAt: g._max.createdAt,
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

export async function listPlayers(params: {
  page: PageSpec;
  q?: string;
  suspendedOnly?: boolean;
}): Promise<{
  rows: Array<{
    id: string;
    walletAddress: string;
    turboUsername: string | null;
    displayName: string | null;
    active: boolean;
    suspendedAt: Date | null;
    suspendReason: string | null;
    creditBalanceWei: bigint;
    createdAt: Date;
    finds: number;
  }>;
  total: number;
}> {
  const q = params.q?.trim().toLowerCase();
  const where: Prisma.PlayerWhereInput = {
    ...(params.suspendedOnly ? { suspendedAt: { not: null } } : {}),
    ...(q
      ? {
          OR: [
            { walletAddress: { contains: q } },
            { turboUsername: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [total, players] = await Promise.all([
    prisma.player.count({ where }),
    prisma.player.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: params.page.skip,
      take: params.page.take,
      select: {
        id: true,
        walletAddress: true,
        turboUsername: true,
        displayName: true,
        active: true,
        suspendedAt: true,
        suspendReason: true,
        creditBalanceWei: true,
        createdAt: true,
        _count: { select: { finds: true } },
      },
    }),
  ]);

  return {
    total,
    rows: players.map((p) => ({
      id: p.id,
      walletAddress: p.walletAddress,
      turboUsername: p.turboUsername,
      displayName: p.displayName,
      active: p.active,
      suspendedAt: p.suspendedAt,
      suspendReason: p.suspendReason,
      creditBalanceWei: weiOf(p.creditBalanceWei),
      createdAt: p.createdAt,
      finds: p._count.finds,
    })),
  };
}

export async function playerDetail(playerId: string) {
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    select: {
      id: true,
      walletAddress: true,
      turboUsername: true,
      displayName: true,
      active: true,
      suspendedAt: true,
      suspendReason: true,
      creditBalanceWei: true,
      createdAt: true,
      passkeyCredentialId: true,
    },
  });
  if (!player) return null;

  const [finds, credits, payouts, attempts, huntStats, attemptTotals] =
    await Promise.all([
      prisma.find.findMany({
        where: { playerId },
        orderBy: { foundAt: "desc" },
        take: 50,
        select: {
          id: true,
          foundAt: true,
          distanceMeters: true,
          accuracyM: true,
          speedKmhFromLast: true,
          rewardCreditSnapshot: true,
          // NOTE: the cache label is a post-find reveal and is safe here; its
          // coordinates are deliberately NOT selected.
          cache: { select: { id: true, label: true } },
          hunt: { select: { id: true, name: true } },
        },
      }),
      prisma.creditLedger.findMany({
        where: { playerId },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
          id: true,
          reason: true,
          amountWei: true,
          balanceAfterWei: true,
          note: true,
          actorId: true,
          createdAt: true,
          hunt: { select: { id: true, name: true } },
        },
      }),
      prisma.payout.findMany({
        where: { playerId },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
          id: true,
          status: true,
          amountMonWei: true,
          autoApproved: true,
          approvedBy: true,
          txHash: true,
          sentAt: true,
          createdAt: true,
          failReason: true,
          voidReason: true,
        },
      }),
      prisma.claimAttempt.findMany({
        where: { playerId },
        orderBy: { attemptedAt: "desc" },
        take: 50,
        select: {
          id: true,
          attemptedAt: true,
          kind: true,
          accepted: true,
          flagged: true,
          reason: true,
          accuracyM: true,
          lat: true,
          lng: true,
          hunt: { select: { id: true, name: true } },
        },
      }),
      prisma.playerHunt.findMany({
        where: { playerId },
        select: {
          huntId: true,
          findCount: true,
          earnedCreditWei: true,
          collectedMonWei: true,
          lastVerifiedAt: true,
          lastSpawnAt: true,
          firstFindAt: true,
          lastFindAt: true,
          hunt: { select: { name: true } },
        },
      }),
      prisma.claimAttempt.groupBy({
        by: ["accepted", "flagged"],
        where: { playerId },
        _count: { _all: true },
      }),
    ]);

  return {
    player: {
      ...player,
      creditBalanceWei: weiOf(player.creditBalanceWei),
    },
    finds: finds.map((f) => ({
      ...f,
      rewardCreditWei: weiOf(f.rewardCreditSnapshot),
    })),
    credits: credits.map((c) => ({
      ...c,
      amount: signedWei(c.amountWei),
      balanceAfter: signedWei(c.balanceAfterWei),
    })),
    payouts: payouts.map((p) => ({ ...p, amountWei: weiOf(p.amountMonWei) })),
    attempts,
    huntStats: huntStats.map((s) => ({
      ...s,
      earnedCredit: weiOf(s.earnedCreditWei),
      collectedMon: weiOf(s.collectedMonWei),
    })),
    attemptTotals: {
      accepted: attemptTotals
        .filter((t) => t.accepted)
        .reduce((n, t) => n + t._count._all, 0),
      rejected: attemptTotals
        .filter((t) => !t.accepted)
        .reduce((n, t) => n + t._count._all, 0),
      flagged: attemptTotals
        .filter((t) => t.flagged)
        .reduce((n, t) => n + t._count._all, 0),
    },
  };
}

// ---------------------------------------------------------------------------
// Hunts and caches
// ---------------------------------------------------------------------------

export async function listHunts() {
  return prisma.hunt.findMany({
    orderBy: [{ active: "desc" }, { createdAt: "desc" }],
    take: 200,
    select: {
      id: true,
      name: true,
      active: true,
      spawnEnabled: true,
      startsAt: true,
      endsAt: true,
      createdAt: true,
      budgetMonWei: true,
      spentMonWei: true,
      budgetCreditWei: true,
      spentCreditWei: true,
      _count: { select: { caches: true, finds: true, spawns: true } },
    },
  });
}

export async function huntDetail(huntId: string) {
  return prisma.hunt.findUnique({ where: { id: huntId } });
}

/**
 * Cache rows INCLUDING coordinates.
 *
 * This is the one function in the codebase that returns them. Its only caller
 * is the OPERATOR-gated cache management screen, and every edit made from that
 * screen writes an AdminAction row.
 */
export async function listCaches(huntId: string, page: PageSpec) {
  const [total, rows] = await Promise.all([
    prisma.cache.count({ where: { huntId } }),
    prisma.cache.findMany({
      where: { huntId },
      orderBy: { createdAt: "desc" },
      skip: page.skip,
      take: page.take,
      select: {
        id: true,
        lat: true,
        lng: true,
        radiusMeters: true,
        rewardCreditWei: true,
        label: true,
        blurb: true,
        photoCid: true,
        active: true,
        createdAt: true,
        _count: { select: { finds: true } },
      },
    }),
  ]);
  return {
    total,
    rows: rows.map((c) => ({ ...c, rewardCredit: weiOf(c.rewardCreditWei) })),
  };
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

export async function listAdminActions(params: {
  page: PageSpec;
  adminId?: string;
  targetId?: string;
}) {
  const where: Prisma.AdminActionWhereInput = {
    ...(params.adminId ? { adminId: params.adminId } : {}),
    ...(params.targetId ? { targetId: params.targetId } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.adminAction.count({ where }),
    prisma.adminAction.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: params.page.skip,
      take: params.page.take,
      include: {
        admin: { select: { walletAddress: true, label: true, role: true } },
      },
    }),
  ]);
  return { total, rows };
}
