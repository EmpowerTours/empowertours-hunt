import { describe, it, expect } from "vitest";
import { checkPriceDrift, planSettlement } from "./settle";

const WMON = (n: bigint) => n * 10n ** 18n;
const base = { costWei: WMON(139n), wmonHeldWei: 0n, allowanceWei: 0n,
               nativeHeldWei: WMON(1000n), gasReserveWei: WMON(1n) };

describe("planSettlement", () => {
  it("wraps the shortfall only, never the whole cost", () => {
    const p = planSettlement({ ...base, wmonHeldWei: WMON(100n) });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.wrapWei).toBe(WMON(39n)); // 139 - 100, not 139
  });

  it("skips the wrap when WMON already covers the cost", () => {
    const p = planSettlement({ ...base, wmonHeldWei: WMON(200n) });
    if (!p.ok) throw new Error("expected ok");
    expect(p.wrapWei).toBe(0n);
    expect(p.steps.some((s) => s.kind === "WRAP")).toBe(false);
  });

  it("skips the approval when the standing allowance already covers it", () => {
    const p = planSettlement({ ...base, wmonHeldWei: WMON(139n), allowanceWei: WMON(139n) });
    if (!p.ok) throw new Error("expected ok");
    expect(p.steps).toEqual([{ kind: "PAY", costWei: WMON(139n) }]);
  });

  it("re-approves when a partly-spent allowance is non-zero but short", () => {
    const p = planSettlement({ ...base, wmonHeldWei: WMON(139n), allowanceWei: WMON(50n) });
    if (!p.ok) throw new Error("expected ok");
    expect(p.approveWei).toBe(WMON(139n));
  });

  it("orders steps wrap -> approve -> pay", () => {
    const p = planSettlement(base);
    if (!p.ok) throw new Error("expected ok");
    expect(p.steps.map((s) => s.kind)).toEqual(["WRAP", "APPROVE", "PAY"]);
  });

  it("refuses when native MON cannot cover the shortfall after the gas reserve", () => {
    // 139 needed, holds 139.5 MON but must leave 1 for gas -> 138.5 spendable.
    const p = planSettlement({ ...base, nativeHeldWei: WMON(1395n) / 10n });
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.reason).toBe("insufficient_native");
    expect(p.shortfallWei).toBe(WMON(5n) / 10n); // 0.5 MON short
  });

  it("counts the gas reserve as unspendable, not as a rounding hint", () => {
    // Exactly cost + reserve is enough; one wei less is not.
    const exact = planSettlement({ ...base, nativeHeldWei: WMON(140n) });
    expect(exact.ok).toBe(true);
    const short = planSettlement({ ...base, nativeHeldWei: WMON(140n) - 1n });
    expect(short.ok).toBe(false);
  });

  it("refuses a zero cost rather than settling for nothing", () => {
    const p = planSettlement({ ...base, costWei: 0n });
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.reason).toBe("cost_not_positive");
  });
});

// ---------------------------------------------------------------------------
// The guard that was missing.
//
// settleRedemption re-read the live tier price and paid THAT, while the row's
// own costCreditWei was parsed and thrown away. The real case: TurboCohortV7
// was set to 0.001 WMON for a test and restored to 139 WMON, so a redemption
// created in between would have settled at 139,000x what its credit bought.
// Nothing in the code objected — the only obstacle was the settler not holding
// 139 WMON, which is an empty wallet, not a control.
// ---------------------------------------------------------------------------
describe("checkPriceDrift", () => {
  const wmon = (n: string) => BigInt(n) * 10n ** 18n;

  it("REFUSES the real incident: credit bought at 0.001, due at 139", () => {
    const credited = 1_000_000_000_000_000n; // 0.001 WMON
    const due = wmon("139");
    const d = checkPriceDrift(credited, due);
    expect(d.ok).toBe(false);
    expect(d.driftBps).toBeGreaterThan(1_000_000); // ~139,000x
  });

  it("refuses the reverse too — settling for far LESS than was charged", () => {
    // Under-paying is not a happy accident: the player was debited 139 WMON of
    // credit and the cohort would receive 0.001.
    expect(checkPriceDrift(wmon("139"), 1_000_000_000_000_000n).ok).toBe(false);
  });

  it("allows an ordinary repricing, which is why this is a band", () => {
    // Tier prices are admin-set and may legitimately move. Refusing every
    // change would wedge settlement on a 1% adjustment.
    expect(checkPriceDrift(wmon("100"), wmon("110")).ok).toBe(true);
    expect(checkPriceDrift(wmon("100"), wmon("90")).ok).toBe(true);
  });

  it("allows an exact match", () => {
    const d = checkPriceDrift(wmon("139"), wmon("139"));
    expect(d).toEqual({ ok: true, driftBps: 0 });
  });

  it("holds the boundary exactly at the tolerance", () => {
    expect(checkPriceDrift(10_000n, 12_500n).driftBps).toBe(2_500);
    expect(checkPriceDrift(10_000n, 12_500n).ok).toBe(true);
    expect(checkPriceDrift(10_000n, 12_501n).ok).toBe(false);
  });

  it("does not truncate a real drift to zero", () => {
    // bigint division truncates. Dividing before scaling would turn a 24%
    // move into 0 and report no movement at all — a guard that reads as green
    // on exactly the input it exists to measure.
    expect(checkPriceDrift(10_000n, 12_400n).driftBps).toBe(2_400);
  });

  it("refuses a row recording no credit rather than dividing by zero", () => {
    // Paying real WMON against a zero-credit row is the overspend itself.
    expect(checkPriceDrift(0n, wmon("139")).ok).toBe(false);
    expect(checkPriceDrift(-1n, wmon("1")).ok).toBe(false);
  });

  it("takes an explicit tolerance", () => {
    expect(checkPriceDrift(10_000n, 11_000n, 500).ok).toBe(false);
    expect(checkPriceDrift(10_000n, 11_000n, 2_000).ok).toBe(true);
  });
});
