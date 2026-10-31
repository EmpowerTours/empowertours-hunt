import { describe, expect, it } from "vitest";
import { tradeOutcome } from "./oneclick-steps";

describe("tradeOutcome — accepted is not open", () => {
  it("refuses the exact response that produced a false 'your trade is open' (2026-10-31)", () => {
    // From the server log: accepted, not filled, venue terminally Failed.
    expect(() =>
      tradeOutcome({
        filled: false,
        venue: { statusName: "Failed", reasonName: "TakerOrderSettlementFailed", terminal: true, expectsFill: false },
      }),
    ).toThrow(/TakerOrderSettlementFailed.*No position was opened/);
  });

  it("does not claim a pending order is open", () => {
    expect(() => tradeOutcome({ filled: false, venue: null })).toThrow(/not filled it yet/);
    expect(() =>
      tradeOutcome({ filled: false, venue: { statusName: "Open", terminal: false, expectsFill: false } }),
    ).toThrow(/not filled it yet/);
  });

  it("is done when it filled", () => {
    expect(tradeOutcome({ filled: true, venue: null })).toBe("filled");
  });

  it("is done when the venue says size changed hands, fill frame still in flight", () => {
    expect(tradeOutcome({ filled: false, venue: { statusName: "Filled", terminal: true, expectsFill: true } })).toBe("filled");
  });
});
