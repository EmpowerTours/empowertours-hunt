import { describe, expect, it } from "vitest";
import { CREDIT_REASON_REDEMPTION, explainRefusal, monthsAffordable, planRedemption, refundForVoid, MAX_MONTHS_PER_REDEMPTION } from "./redeem";

const WEI = 10n ** 18n;
/** 139 WMON — the Explorer price at the time of writing. Read from chain in production. */
const MONTH = 139n * WEI;

describe("how many months a balance buys", () => {
  it("truncates rather than rounding up", () => {
    // Rounding up hands out a month nobody earned, and every one of those is a
    // real subscription somebody has to pay for.
    expect(monthsAffordable(MONTH - 1n, MONTH)).toBe(0);
    expect(monthsAffordable(MONTH, MONTH)).toBe(1);
    expect(monthsAffordable(MONTH * 2n - 1n, MONTH)).toBe(1);
    expect(monthsAffordable(MONTH * 3n, MONTH)).toBe(3);
  });

  it("is zero for an empty balance or an unreadable price", () => {
    expect(monthsAffordable(0n, MONTH)).toBe(0);
    expect(monthsAffordable(MONTH, 0n)).toBe(0);
  });
});

describe("planning a redemption", () => {
  it("charges exactly the price times the months", () => {
    // Was months=2 before MAX_MONTHS_PER_REDEMPTION capped redemptions at one.
    // The multiplication still exists for when the cap is raised; at 1 it is
    // the identity, which is all the cohort can settle in one call.
    const plan = planRedemption(MONTH * 3n, MONTH, MAX_MONTHS_PER_REDEMPTION);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.costWei).toBe(MONTH * BigInt(MAX_MONTHS_PER_REDEMPTION));
    expect(plan.months).toBe(MAX_MONTHS_PER_REDEMPTION);
  });

  it("writes a NEGATIVE ledger amount and the resulting balance", () => {
    const plan = planRedemption(MONTH * 3n, MONTH, 1);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.debit.reason).toBe(CREDIT_REASON_REDEMPTION);
    expect(plan.debit.amountWei).toBe(-MONTH);
    expect(plan.debit.balanceAfterWei).toBe(MONTH * 2n);
  });

  it("allows spending the balance down to exactly zero", () => {
    // A balance of exactly one month, redeemed, must land on zero rather than
    // refusing at the boundary.
    const plan = planRedemption(MONTH, MONTH, 1);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.debit.balanceAfterWei).toBe(0n);
  });
});

describe("refusals a player can actually cause", () => {
  it("refuses one wei short of a month", () => {
    expect(planRedemption(MONTH - 1n, MONTH, 1)).toEqual({
      ok: false,
      reason: "not_enough_credit",
    });
  });

  it("reports months_exceed_max, not months_exceed_balance, while the cap is 1", () => {
    // months_exceed_balance is UNREACHABLE at MAX_MONTHS_PER_REDEMPTION = 1:
    // the only allowed request is 1 month, and "1 > affordable" implies
    // affordable === 0, which not_enough_credit already caught. The branch is
    // kept because raising the cap makes it live again — this test pins which
    // refusal a player actually sees today.
    expect(planRedemption(MONTH, MONTH, 2)).toEqual({
      ok: false,
      reason: "months_exceed_max",
    });
  });

  it("refuses zero, negative and fractional months", () => {
    for (const months of [0, -1, 1.5]) {
      expect(planRedemption(MONTH * 5n, MONTH, months)).toEqual({
        ok: false,
        reason: "months_not_positive",
      });
    }
  });

  it("refuses a zero price instead of treating it as free", () => {
    // A zero price is a failed read of on-chain state, not a sale. Treating it
    // as free would mint subscriptions out of nothing — and it would do so
    // precisely when the RPC was having a bad day.
    expect(planRedemption(MONTH * 5n, 0n, 1)).toEqual({
      ok: false,
      reason: "no_price",
    });
  });
});

describe("a negative balance is a bug, not a refusal", () => {
  it("throws rather than quietly redeeming", () => {
    // The database makes this impossible. Reaching here with one means
    // something upstream is already wrong, and proceeding would launder that
    // bug into a settled subscription.
    expect(() => planRedemption(-1n, MONTH, 1)).toThrow(RangeError);
  });
});

describe("voiding gives the credit back as a new row", () => {
  it("returns exactly what was spent", () => {
    const plan = planRedemption(MONTH * 2n, MONTH, 1);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const refund = refundForVoid(plan.debit.balanceAfterWei, plan.costWei);
    expect(refund.amountWei).toBe(MONTH);
    // Back where it started: the ledger shows both the spend and the return,
    // which is what actually happened.
    expect(refund.balanceAfterWei).toBe(MONTH * 2n);
  });

  it("refuses to refund nothing", () => {
    expect(() => refundForVoid(MONTH, 0n)).toThrow(RangeError);
    expect(() => refundForVoid(MONTH, -1n)).toThrow(RangeError);
  });
});

describe("refusals are explained in both languages", () => {
  it("says something different in each, for every reason", () => {
    const reasons = [
      "no_price",
      "not_enough_credit",
      "months_not_positive",
      "months_exceed_balance",
    ] as const;
    for (const r of reasons) {
      const es = explainRefusal(r, "es");
      const en = explainRefusal(r, "en");
      expect(es.length).toBeGreaterThan(0);
      expect(en.length).toBeGreaterThan(0);
      expect(es).not.toBe(en);
    }
  });
});

describe("MAX_MONTHS_PER_REDEMPTION", () => {
  const PRICE = 139n * 10n ** 18n;

  it("is one, because the cohort delivers one month per 25 days", () => {
    // Not a style preference: TurboCohortV7._recordPayment does monthsPaid++
    // and reverts "too soon" inside MIN_PAYMENT_INTERVAL. A larger value here
    // would let a player buy months that can never be settled in one call.
    expect(MAX_MONTHS_PER_REDEMPTION).toBe(1);
  });

  it("refuses two months even when the balance easily covers them", () => {
    const plan = planRedemption(PRICE * 10n, PRICE, 2);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe("months_exceed_max");
  });

  it("refuses the old upper bound of twelve", () => {
    const plan = planRedemption(PRICE * 100n, PRICE, 12);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe("months_exceed_max");
  });

  it("still allows one month", () => {
    const plan = planRedemption(PRICE * 3n, PRICE, 1);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.months).toBe(1);
    expect(plan.costWei).toBe(PRICE);
  });

  it("prefers months_exceed_max over months_exceed_balance", () => {
    // Both are true for this input. The cap is the more fundamental refusal:
    // topping up the balance would not make a 3-month redemption settleable.
    const plan = planRedemption(0n, PRICE, 3);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe("months_exceed_max");
  });

  it("explains the refusal in both languages", () => {
    expect(explainRefusal("months_exceed_max", "en")).toMatch(/one month at a time/i);
    expect(explainRefusal("months_exceed_max", "es")).toMatch(/un mes a la vez/i);
  });
});
