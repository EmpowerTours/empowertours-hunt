import { describe, expect, it } from "vitest";
import {
  belowDeskMinimum,
  explainSwapError,
  formatMonCeil,
  minMonForDesk,
} from "./swap";

// Numbers read from MonAusdSwapOracle on a Monad mainnet fork, 2026-10-27,
// MON/USD $0.021316: quote(44 MON) = 928727 (0.928727 AUSD), minSwapAusd =
// 1000000 (1 AUSD), and a 47.851 MON swap paid out 1.010020 AUSD.
const MIN = 1_000_000n;
const ONE = 10n ** 18n;
const PER_MON = 21_107n; // quote(1 MON) at that block, 6dp AUSD (928727 / 44, floored)
const mon = (s: string) => {
  const [i, f = ""] = s.split(".");
  return BigInt(i) * ONE + BigInt((f + "0".repeat(18)).slice(0, 18));
};
const payout = (wei: bigint) => (wei * PER_MON) / ONE;

describe("minMonForDesk", () => {
  it("44 MON at $0.021316 is below the desk floor and is rejected", () => {
    expect(payout(mon("44"))).toBeLessThan(MIN);
    expect(belowDeskMinimum(mon("44"), minMonForDesk(MIN, PER_MON))).toBe(true);
  });

  it("47.85 MON clears the desk's own floor (no headroom)", () => {
    const floor = minMonForDesk(MIN, PER_MON, 0n);
    expect(belowDeskMinimum(mon("47.85"), floor)).toBe(false);
    expect(payout(mon("47.85"))).toBeGreaterThanOrEqual(MIN);
  });

  it("the shown minimum includes 1% headroom and is rounded up", () => {
    const m = minMonForDesk(MIN, PER_MON)!;
    expect(formatMonCeil(m)).toBe("47.86");
    expect(belowDeskMinimum(mon("47.86"), m)).toBe(false);
    expect(payout(m)).toBeGreaterThanOrEqual(MIN);
  });

  it("ceil(min*1e18/quote) then *1.01, exactly", () => {
    const raw = (MIN * ONE + PER_MON - 1n) / PER_MON;
    expect(minMonForDesk(MIN, PER_MON, 0n)).toBe(raw);
    expect(minMonForDesk(MIN, PER_MON)).toBe((raw * 10_100n + 9_999n) / 10_000n);
  });

  it("returns null without a usable quote instead of a wrong number", () => {
    expect(minMonForDesk(MIN, 0n)).toBeNull();
    expect(minMonForDesk(0n, PER_MON)).toBeNull();
    expect(belowDeskMinimum(mon("1"), null)).toBe(false);
  });
});

describe("explainSwapError below minimum", () => {
  const err = new Error("execution reverted: below minimum");
  it("names the live minimum in Spanish and English", () => {
    const m = minMonForDesk(MIN, PER_MON);
    expect(explainSwapError(err, "es", m)).toContain("47.86 MON");
    expect(explainSwapError(err, "en", m)).toContain("47.86 MON");
    expect(explainSwapError(err, "es", m)).not.toContain("44");
  });
  it("asks to retry when the minimum is unknown", () => {
    expect(explainSwapError(err, "es")).toMatch(/intenta de nuevo/i);
    expect(explainSwapError(err, "en")).toMatch(/try again/i);
  });
});
