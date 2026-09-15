import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    cotaOrder: { findMany: vi.fn() },
  },
}));

import { prisma } from "@/lib/db/prisma";
import { loadOrdersPlacedSince, loadPendingOrders } from "./ledger";

const findMany = prisma.cotaOrder.findMany as unknown as ReturnType<
  typeof vi.fn
>;

beforeEach(() => {
  findMany.mockReset();
  findMany.mockResolvedValue([]);
});

// These two queries decide what the trades-per-day ceiling counts and what may
// explain a position. A row marked dead is an order the chain never executed:
// it is not a trade and it opened nothing. Both queries must exclude it, and
// the exclusion is easy to lose in a refactor because nothing else observes it —
// the ceiling would simply read high again and the hunter would be told they
// had spent trades they never made.
describe("ledger queries exclude dead orders", () => {
  it("the trades-per-day ceiling does not count an order that never reached the chain", async () => {
    await loadOrdersPlacedSince("p1", "0xABC", 1_700_000_000_000);
    expect(findMany).toHaveBeenCalledTimes(1);
    const where = findMany.mock.calls[0][0].where;
    expect(where.deadAt).toBeNull();
    // and still counts orders that merely filled — resolvedAt must NOT be a
    // filter here, or the ceiling falls every time a fill is adopted.
    expect(where).not.toHaveProperty("resolvedAt");
  });

  it("a dead order cannot explain a position either", async () => {
    await loadPendingOrders("p1", "0xABC");
    const where = findMany.mock.calls[0][0].where;
    expect(where.deadAt).toBeNull();
    expect(where.resolvedAt).toBeNull();
  });

  it("scopes both queries to the account, lowercased", async () => {
    await loadOrdersPlacedSince("p1", "0xABC", 0);
    await loadPendingOrders("p1", "0xABC");
    for (const call of findMany.mock.calls) {
      expect(call[0].where.account).toBe("0xabc");
      expect(call[0].where.playerId).toBe("p1");
    }
  });
});
