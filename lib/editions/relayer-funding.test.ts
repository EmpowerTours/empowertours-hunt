// The relayer is paid in MON and settles in WMON. These are the numbers that
// bridge the two, and every one of them decides whether money moves.
//
// The case that produced this file: a relayer funded with MON and no WMON,
// holding no allowance, reverting inside `_settle` AFTER the hunter's payment
// was verified and their claim row written. Nothing in the module looked at
// either balance.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_GAS_RESERVE_WEI,
  maxSettleableWei,
  planFunding,
  type RelayerFunds,
} from "./relayer";

const MON = 1_000_000_000_000_000_000n;
/** Dime Que Sí, master 13, as priced on chain 2026-09-20. */
const PRICE = 800_000_000_000_000_000n;
const RESERVE = DEFAULT_GAS_RESERVE_WEI; // 0.1 MON

const funds = (
  wmon: bigint,
  native: bigint,
  allowance = 0n,
): RelayerFunds => ({
  wmonWei: wmon,
  nativeWei: native,
  allowanceWei: allowance,
});

describe("planFunding", () => {
  it("wraps exactly the shortfall, never the whole balance", () => {
    const plan = planFunding(funds(0n, 5n * MON), PRICE, RESERVE);
    expect(plan).toEqual({ ok: true, wrapWei: PRICE, approve: true });
  });

  it("wraps nothing when WMON already covers the price", () => {
    const plan = planFunding(funds(2n * MON, MON), PRICE, RESERVE);
    expect(plan.ok && plan.wrapWei).toBe(0n);
  });

  it("still demands the reserve when no wrap is needed", () => {
    // Plenty of WMON, but not enough MON left to send purchase + transfer.
    // Monad charges the full gas limit, so this wallet cannot complete a sale
    // it can perfectly well afford in settlement terms.
    const plan = planFunding(funds(10n * MON, RESERVE - 1n), PRICE, RESERVE);
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.shortfallWei).toBe(1n);
  });

  it("refuses when native cannot cover the wrap AND the reserve", () => {
    // 0.85 MON against a 0.8 price: enough to wrap, not enough to then send.
    const plan = planFunding(funds(0n, 850_000_000_000_000_000n), PRICE, RESERVE);
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.shortfallWei).toBe(50_000_000_000_000_000n);
  });

  it("a wallet holding EXACTLY the price cannot fund it", () => {
    // The stranding this guards: wrapping everything converts the gas money
    // into WMON and leaves nothing to send the purchase with.
    const plan = planFunding(funds(0n, PRICE), PRICE, RESERVE);
    expect(plan.ok).toBe(false);
  });

  it("approves only when the standing allowance is short", () => {
    expect(planFunding(funds(MON, MON, PRICE), PRICE, RESERVE)).toEqual({
      ok: true,
      wrapWei: 0n,
      approve: false,
    });
    expect(
      planFunding(funds(MON, MON, PRICE - 1n), PRICE, RESERVE).ok &&
        planFunding(funds(MON, MON, PRICE - 1n), PRICE, RESERVE),
    ).toMatchObject({ approve: true });
  });

  it("rejects a zero price rather than funding a call that reverts", () => {
    // ZeroPrice at the venue. Funding it would spend gas to fail.
    expect(() => planFunding(funds(MON, MON), 0n, RESERVE)).toThrow(RangeError);
  });
});

describe("maxSettleableWei", () => {
  it("counts wrappable native beyond the reserve", () => {
    expect(maxSettleableWei(funds(MON, 3n * MON), RESERVE)).toBe(
      MON + 3n * MON - RESERVE,
    );
  });

  it("never goes negative when native is below the reserve", () => {
    expect(maxSettleableWei(funds(MON, RESERVE / 2n), RESERVE)).toBe(MON);
  });

  it("agrees with planFunding at the boundary", () => {
    // The two are the same arithmetic read from opposite ends, and placement
    // filters on one while the purchase checks the other. If they disagreed,
    // a card would be shown for a work that then refuses to fund.
    const f = funds(300_000_000_000_000_000n, 2n * MON, 0n);
    const cap = maxSettleableWei(f, RESERVE);
    expect(planFunding(f, cap, RESERVE).ok).toBe(true);
    expect(planFunding(f, cap + 1n, RESERVE).ok).toBe(false);
  });
});
