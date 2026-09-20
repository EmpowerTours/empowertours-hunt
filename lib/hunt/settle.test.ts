import { describe, it, expect } from "vitest";
import { planSettlement } from "./settle";

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
