import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db/prisma", () => ({
  prisma: { cota: { updateMany: vi.fn() } },
}));

import { prisma } from "@/lib/db/prisma";
import { LEASE_MS, releaseAgentLease, takeAgentLease } from "./lease";

const updateMany = prisma.cota.updateMany as unknown as ReturnType<
  typeof vi.fn
>;
const NOW = Date.UTC(2026, 8, 17, 12, 0, 0);

beforeEach(() => updateMany.mockReset());

describe("the lease is taken by the DATABASE, not by a read", () => {
  it("claims only when the row was actually updated", async () => {
    updateMany.mockResolvedValue({ count: 1 });
    expect(await takeAgentLease("c1", NOW)).toBe(true);

    updateMany.mockResolvedValue({ count: 0 });
    expect(await takeAgentLease("c1", NOW)).toBe(false);
  });

  it("matches only a free or EXPIRED lease", async () => {
    // The conditional is what makes this single-flight. Widen it and two
    // concurrent runs both win, both close the same position, and the position
    // flips instead of closing.
    updateMany.mockResolvedValue({ count: 1 });
    await takeAgentLease("c1", NOW);
    const { where, data } = updateMany.mock.calls[0][0];
    expect(where.id).toBe("c1");
    expect(where.OR).toEqual([
      { agentLeaseUntil: null },
      { agentLeaseUntil: { lt: new Date(NOW) } },
    ]);
    expect(data.agentLeaseUntil).toEqual(new Date(NOW + LEASE_MS));
  });

  it("expires rather than wedging — a dead run frees itself", async () => {
    // A run that died holding the lease left a timestamp in the past, which the
    // `lt` clause matches, so the next tick takes it.
    updateMany.mockResolvedValue({ count: 1 });
    const later = NOW + LEASE_MS + 1;
    await takeAgentLease("c1", later);
    expect(updateMany.mock.calls[0][0].where.OR[1]).toEqual({
      agentLeaseUntil: { lt: new Date(later) },
    });
  });

  it("holds long enough for a slow run but not for an hour", () => {
    expect(LEASE_MS).toBeGreaterThanOrEqual(60_000);
    expect(LEASE_MS).toBeLessThanOrEqual(300_000);
  });
});
