import { describe, expect, it } from "vitest";
import {
  governsLiveOrders,
  liveLeashWhere,
  tradableMarketOf,
  type LeashRow,
} from "./active-leash";
import { executableSymbols } from "./order";

const ok: LeashRow = {
  revokedAt: null,
  anchorTxHash: "0xa7599b73",
  markets: ["MON"],
};

describe("governsLiveOrders", () => {
  it("accepts an anchored, unrevoked leash naming a reachable market", () => {
    expect(governsLiveOrders(ok)).toBe(true);
  });

  it("rejects a revoked leash", () => {
    expect(governsLiveOrders({ ...ok, revokedAt: new Date() })).toBe(false);
  });

  it("rejects a PRACTICE leash — signed, never anchored", () => {
    // The hole this closes: practice mode is meant to cost nothing and
    // authorise nothing, and its leash lands in the same table with a null
    // anchor. Without this it would silently outrank the live leash by being
    // newer, and govern real money.
    expect(governsLiveOrders({ ...ok, anchorTxHash: null })).toBe(false);
  });

  it("rejects a leash naming only markets the executor cannot reach", () => {
    expect(governsLiveOrders({ ...ok, markets: ["BTC", "PUMP"] })).toBe(false);
  });

  it("accepts a mixed leash, and trades only the reachable market", () => {
    const mixed = { ...ok, markets: ["BTC", "MON"] };
    expect(governsLiveOrders(mixed)).toBe(true);
    expect(tradableMarketOf(mixed)).toBe("MON");
  });

  it("names no tradable market when none is reachable", () => {
    expect(tradableMarketOf({ ...ok, markets: ["BTC"] })).toBeNull();
  });
});

describe("the query and the predicate must not drift apart", () => {
  // They are two encodings of one rule, on opposite sides of the wire. The
  // failure they caused before was a page previewing "allowed" against a leash
  // the server would not have used.
  const where = liveLeashWhere("p1");

  it("filters on the same three conditions", () => {
    expect(where.playerId).toBe("p1");
    expect(where.revokedAt).toBeNull();
    expect(where.anchorTxHash).toEqual({ not: null });
    expect(where.markets).toEqual({ hasSome: executableSymbols() });
  });

  it("agrees with the predicate on every combination that matters", () => {
    // The predicate's answer, and what the query's clauses would admit.
    const rows: LeashRow[] = [
      ok,
      { ...ok, revokedAt: new Date() },
      { ...ok, anchorTxHash: null },
      { ...ok, markets: ["BTC"] },
      { ...ok, markets: [] },
      { ...ok, markets: ["BTC", "MON"] },
    ];
    const admittedByQuery = (c: LeashRow) =>
      c.revokedAt === null &&
      c.anchorTxHash !== null &&
      c.markets.some((m) =>
        (where.markets.hasSome as readonly string[]).includes(m),
      );
    for (const r of rows) {
      expect(governsLiveOrders(r)).toBe(admittedByQuery(r));
    }
  });
});
