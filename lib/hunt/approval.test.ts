import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocked at the module boundary: the pure decision needs no database, and the
// one function that does read the DB is tested against a fake so the assertion
// is about the QUERY it builds, which is where a cap silently stops applying.
vi.mock("@/lib/db/prisma", () => ({
  prisma: { payout: { aggregate: vi.fn() } },
}));

import { prisma } from "@/lib/db/prisma";
import {
  decideAutoApproval,
  sumAutoApprovedLast24hWei,
  type AutoApprovalContext,
} from "@/lib/hunt/approval";

const MON = 10n ** 18n;
const SPAWN = MON / 1000n; // 0.001 MON

function ctx(over: Partial<AutoApprovalContext> = {}): AutoApprovalContext {
  return {
    amountWei: SPAWN,
    autoApproveMaxWei: 2n * SPAWN,
    autoApproveDailyCapWei: 100n * SPAWN,
    autoApprovedLast24hWei: 0n,
    attemptFlagged: false,
    playerSuspended: false,
    playerActive: true,
    ...over,
  };
}

describe("decideAutoApproval", () => {
  it("releases a small, clean spawn payout", () => {
    expect(decideAutoApproval(ctx())).toEqual({ autoApprove: true });
  });

  it("holds a flagged attempt at any amount", () => {
    // The verifier suspected a spoof. No amount is small enough to skip a
    // person after that.
    const d = decideAutoApproval(ctx({ attemptFlagged: true, amountWei: 1n }));
    expect(d.autoApprove).toBe(false);
    if (!d.autoApprove) expect(d.reason).toBe("attempt_flagged");
  });

  it("holds a suspended or inactive player", () => {
    const s = decideAutoApproval(ctx({ playerSuspended: true }));
    expect(s.autoApprove).toBe(false);
    if (!s.autoApprove) expect(s.reason).toBe("player_suspended");

    const i = decideAutoApproval(ctx({ playerActive: false }));
    expect(i.autoApprove).toBe(false);
    if (!i.autoApprove) expect(i.reason).toBe("player_not_active");
  });

  it("treats autoApproveMaxWei = 0 as auto-approval OFF, not as no limit", () => {
    // This is the schema default, so an unconfigured hunt must pay nothing
    // automatically. Reading 0 as "no ceiling" would invert the default into
    // an unbounded faucet.
    const d = decideAutoApproval(ctx({ autoApproveMaxWei: 0n }));
    expect(d.autoApprove).toBe(false);
    if (!d.autoApprove) expect(d.reason).toBe("auto_approval_disabled");
  });

  it("treats autoApproveDailyCapWei = 0 the same way", () => {
    const d = decideAutoApproval(ctx({ autoApproveDailyCapWei: 0n }));
    expect(d.autoApprove).toBe(false);
    if (!d.autoApprove) expect(d.reason).toBe("auto_approval_disabled");
  });

  it("holds an amount above the per-payout cap", () => {
    const d = decideAutoApproval(ctx({ amountWei: 2n * SPAWN + 1n }));
    expect(d.autoApprove).toBe(false);
    if (!d.autoApprove) expect(d.reason).toBe("amount_above_per_payout_cap");
  });

  it("allows an amount exactly at the per-payout cap", () => {
    expect(decideAutoApproval(ctx({ amountWei: 2n * SPAWN }))).toEqual({
      autoApprove: true,
    });
  });

  it("counts the payout being decided against the rolling 24h cap", () => {
    // At the boundary: 99 already released, cap 100, this one is 1 -> allowed.
    expect(
      decideAutoApproval(
        ctx({
          autoApprovedLast24hWei: 99n * SPAWN,
          amountWei: SPAWN,
        }),
      ),
    ).toEqual({ autoApprove: true });

    // One wei more and the window is full. A cap that only compared the
    // running total would let this through and end the day over budget.
    const d = decideAutoApproval(
      ctx({ autoApprovedLast24hWei: 99n * SPAWN + 1n, amountWei: SPAWN }),
    );
    expect(d.autoApprove).toBe(false);
    if (!d.autoApprove) expect(d.reason).toBe("daily_auto_approve_cap");
  });

  it("holds a non-positive amount", () => {
    for (const amountWei of [0n, -1n]) {
      const d = decideAutoApproval(ctx({ amountWei }));
      expect(d.autoApprove).toBe(false);
      if (!d.autoApprove) expect(d.reason).toBe("non_positive_amount");
    }
  });

  it("holds when the rolling total is itself nonsense", () => {
    const d = decideAutoApproval(ctx({ autoApprovedLast24hWei: -5n }));
    expect(d.autoApprove).toBe(false);
    if (!d.autoApprove) expect(d.reason).toBe("daily_auto_approve_cap");
  });
});

describe("sumAutoApprovedLast24hWei", () => {
  const aggregate = vi.mocked(prisma.payout.aggregate);

  beforeEach(() => {
    aggregate.mockReset();
  });

  it("sums only auto-approved, non-voided payouts of this hunt in the window", async () => {
    aggregate.mockResolvedValue({
      _sum: { amountMonWei: "3000000000000000" },
    } as never);

    const now = new Date("2026-08-12T12:00:00.000Z");
    const total = await sumAutoApprovedLast24hWei("hunt_1", now);
    expect(total).toBe(3_000_000_000_000_000n);

    const where = aggregate.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.autoApproved).toBe(true);
    expect(where.spawn).toEqual({ huntId: "hunt_1" });
    expect(where.status).toEqual({ not: "VOIDED" });
    expect((where.createdAt as { gte: Date }).gte).toEqual(
      new Date("2026-08-11T12:00:00.000Z"),
    );
  });

  it("reads an empty window as zero, not as null", async () => {
    aggregate.mockResolvedValue({ _sum: { amountMonWei: null } } as never);
    expect(await sumAutoApprovedLast24hWei("hunt_1", new Date())).toBe(0n);
  });

  it("goes through toWei, so a Decimal past 1e21 does not throw", async () => {
    // Prisma's Decimal.toString() switches to "1e+21" at 1000 MON and BigInt()
    // refuses it. toWei reads toFixed() instead.
    aggregate.mockResolvedValue({
      _sum: {
        amountMonWei: {
          toFixed: () => "1000000000000000000000",
          toString: () => "1e+21",
        },
      },
    } as never);
    expect(await sumAutoApprovedLast24hWei("hunt_1", new Date())).toBe(
      10n ** 21n,
    );
  });
});
