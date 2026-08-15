import { describe, it, expect } from "vitest";
import {
  budgetAllows,
  creditForFind,
  findCapAllows,
  CREDIT_REASON_CACHE_FIND,
} from "./credit";

const ONE_WMON = 1_000_000_000_000_000_000n;
/** One month of Explorer, roughly — the scale credit is actually measured at. */
const EXPLORER_MONTH = 139n * ONE_WMON;

describe("creditForFind", () => {
  it("issues the cache reward and reports the resulting balance", () => {
    const entry = creditForFind(EXPLORER_MONTH, ONE_WMON / 2n);
    expect(entry).not.toBeNull();
    expect(entry!.reason).toBe(CREDIT_REASON_CACHE_FIND);
    expect(entry!.amountWei).toBe(ONE_WMON / 2n);
    expect(entry!.balanceAfterWei).toBe(EXPLORER_MONTH + ONE_WMON / 2n);
  });

  it("keeps full precision at wei scale", () => {
    // The number that motivates bigint: this survives here and would not
    // survive a double. 1e18 + 1 === 1e18 in float.
    const odd = ONE_WMON + 1n;
    const entry = creditForFind(ONE_WMON, odd);
    expect(entry!.balanceAfterWei).toBe(2n * ONE_WMON + 1n);
    expect(entry!.balanceAfterWei).not.toBe(2n * ONE_WMON);
  });

  it("writes no ledger row for a zero-reward cache", () => {
    // A landmark cache with no credit attached is legal; a ledger row that
    // moves nothing is noise in the record a human reads during a dispute.
    expect(creditForFind(EXPLORER_MONTH, 0n)).toBeNull();
  });

  it("refuses a negative reward rather than debiting the player", () => {
    expect(() => creditForFind(EXPLORER_MONTH, -1n)).toThrow(RangeError);
  });

  it("refuses to issue on top of a negative balance", () => {
    // Impossible if the DB constraints hold, which is why reaching it means
    // something upstream is already broken. Failing closed keeps the bug out
    // of someone's balance.
    expect(() => creditForFind(-1n, ONE_WMON)).toThrow(RangeError);
  });

  it("is pure — the same inputs always give the same entry", () => {
    const a = creditForFind(EXPLORER_MONTH, ONE_WMON);
    const b = creditForFind(EXPLORER_MONTH, ONE_WMON);
    expect(a).toEqual(b);
  });
});

// C4 — these predicates document the ceilings; the ENFORCEMENT is the
// conditional UPDATE in app/api/hunt/[huntId]/claim/route.ts, whose
// affected-row count is checked inside the transaction that writes the Find.
// They are tested so the SQL has an executable specification to match.
describe("budgetAllows", () => {
  it("treats a zero budget as no ceiling, matching the schema default", () => {
    expect(budgetAllows(EXPLORER_MONTH * 1_000n, ONE_WMON, 0n)).toBe(true);
  });

  it("allows a find that exactly exhausts the budget", () => {
    expect(
      budgetAllows(EXPLORER_MONTH - ONE_WMON, ONE_WMON, EXPLORER_MONTH),
    ).toBe(true);
  });

  it("refuses the find that would cross the budget by one wei", () => {
    expect(
      budgetAllows(EXPLORER_MONTH - ONE_WMON, ONE_WMON + 1n, EXPLORER_MONTH),
    ).toBe(false);
  });

  it("refuses a negative reward", () => {
    expect(budgetAllows(0n, -1n, EXPLORER_MONTH)).toBe(false);
  });

  it("is what K concurrent claims must NOT be allowed to evaluate at once", () => {
    // The TOCTOU this replaces: every claim reads the same `spent`, every one
    // of them passes, and the hunt overspends by (K-1) rewards. In SQL the
    // second reader sees the first writer's row.
    const spent = EXPLORER_MONTH - ONE_WMON;
    const concurrent = Array.from({ length: 8 }, () =>
      budgetAllows(spent, ONE_WMON, EXPLORER_MONTH),
    );
    expect(concurrent.every(Boolean)).toBe(true);
    // Applied serially — which is what the conditional UPDATE forces — only
    // the first one may pass.
    let running = spent;
    const serial = concurrent.map(() => {
      const ok = budgetAllows(running, ONE_WMON, EXPLORER_MONTH);
      if (ok) running += ONE_WMON;
      return ok;
    });
    expect(serial.filter(Boolean)).toHaveLength(1);
  });
});

describe("findCapAllows", () => {
  it("treats a zero cap as disabled, matching the schema default", () => {
    expect(findCapAllows(9_999, 0)).toBe(true);
  });

  it("allows the find that reaches the cap and refuses the next", () => {
    expect(findCapAllows(4, 5)).toBe(true);
    expect(findCapAllows(5, 5)).toBe(false);
  });

  it("refuses nonsense counters instead of defaulting to permissive", () => {
    expect(findCapAllows(-1, 5)).toBe(false);
    expect(findCapAllows(1.5, 5)).toBe(false);
    expect(findCapAllows(NaN, 5)).toBe(false);
    expect(findCapAllows(1, -5)).toBe(false);
    expect(findCapAllows(1, NaN)).toBe(false);
  });

  it("only lets one of K concurrent claims through when applied serially", () => {
    let count = 4;
    const results = Array.from({ length: 6 }, () => {
      const ok = findCapAllows(count, 5);
      if (ok) count += 1;
      return ok;
    });
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
