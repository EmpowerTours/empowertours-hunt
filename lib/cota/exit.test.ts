import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXIT_POLICY,
  exitMath,
  PER_SIDE_FEE_BPS,
  shouldExit,
  type PositionSnapshot,
} from "./exit";

// Account 5273 as it stands: long 576 MON entered at 0.022531778 (ep + epr),
// 0.011553 of fees charged so far.
const ENTRY = 0.022531778;
const live = (exitPriceUsd: number): PositionSnapshot => ({
  signedSize: 576,
  entryUsd: ENTRY,
  exitPriceUsd,
  feesPaidUsd: 0.011553,
});

describe("it never closes at a loss — the instruction, as a test", () => {
  it("holds every position that is net down, however far", () => {
    // Swept rather than spot-checked. There is no stop: down 10 bps or down
    // 1000, the answer is hold.
    for (let bps = -1000; bps < 0; bps += 10) {
      const d = shouldExit(live(ENTRY * (1 + bps / 10_000)));
      expect(d.act).toBe("hold");
    }
  });

  it("never returns close with a negative or zero net", () => {
    // The invariant that matters most. If this ever fails, the agent is
    // realising losses it was told not to realise.
    for (let bps = -1000; bps <= 1000; bps += 5) {
      const d = shouldExit(live(ENTRY * (1 + bps / 10_000)));
      if (d.act === "close") expect(d.math.netUsd).toBeGreaterThan(0);
    }
  });
});

describe("net, not gross", () => {
  it("a gain against the entry can still be a loss once costed", () => {
    // +10 bps of price move on ~$13 of notional is ~$0.013, and the fees alone
    // are ~$0.023. Closing here realises a loss, so it must hold.
    const m = exitMath(live(ENTRY * 1.001));
    expect(m.grossUsd).toBeGreaterThan(0);
    expect(m.netUsd).toBeLessThan(0);
    expect(shouldExit(live(ENTRY * 1.001)).act).toBe("hold");
  });

  it("subtracts fees already paid AND the fee still to pay", () => {
    const m = exitMath(live(ENTRY));
    expect(m.grossUsd).toBeCloseTo(0, 9);
    expect(m.exitFeeUsd).toBeCloseTo(
      (576 * ENTRY * PER_SIDE_FEE_BPS) / 10_000,
      9,
    );
    expect(m.netUsd).toBeCloseTo(-(0.011553 + m.exitFeeUsd), 9);
  });

  it("prices the exit where it would FILL, not at the mid", () => {
    // A long closes at the bid. Valuing it at the mid overstates the close by
    // half the spread, which on MON was 24.2 bps — larger than the fees.
    const mid = ENTRY * 1.02;
    const bid = mid * (1 - 12.1 / 10_000);
    expect(exitMath(live(bid)).netUsd).toBeLessThan(exitMath(live(mid)).netUsd);
  });
});

describe("take profit", () => {
  it("holds just under the threshold", () => {
    // +100 bps of price move nets ~82 bps after ~18 bps of fees.
    expect(shouldExit(live(ENTRY * 1.01)).act).toBe("hold");
  });

  it("closes once NET clears it", () => {
    const d = shouldExit(live(ENTRY * 1.013));
    expect(d.act).toBe("close");
    if (d.act === "close") {
      expect(d.reason).toBe("take_profit");
      expect(d.math.netBps).toBeGreaterThanOrEqual(
        DEFAULT_EXIT_POLICY.takeProfitBps,
      );
      expect(d.math.netUsd).toBeGreaterThan(0);
    }
  });

  it("a threshold of zero or less STILL does not realise a loss", () => {
    // Without the explicit net guard this is where the instruction breaks.
    // netBps >= takeProfitBps is enough while the threshold is positive, so the
    // guard reads as redundant and invites deletion — until somebody lowers the
    // threshold to exit sooner and the agent starts closing losers.
    for (const takeProfitBps of [0, -50]) {
      for (let bps = -300; bps < 0; bps += 10) {
        const d = shouldExit(live(ENTRY * (1 + bps / 10_000)), {
          takeProfitBps,
        });
        expect(d.act).toBe("hold");
      }
    }
  });

  it("honours a policy that asks for more", () => {
    const at = live(ENTRY * 1.013);
    expect(shouldExit(at, { takeProfitBps: 100 }).act).toBe("close");
    expect(shouldExit(at, { takeProfitBps: 500 }).act).toBe("hold");
  });
});

describe("shorts and flat", () => {
  it("a short profits as the price falls, and closes at the ASK", () => {
    const short: PositionSnapshot = {
      signedSize: -576,
      entryUsd: ENTRY,
      exitPriceUsd: ENTRY * 0.987,
      feesPaidUsd: 0.011553,
    };
    const d = shouldExit(short);
    expect(d.act).toBe("close");
    if (d.act === "close") expect(d.math.netUsd).toBeGreaterThan(0);
  });

  it("a short that moves against it holds, like a long", () => {
    expect(
      shouldExit({
        signedSize: -576,
        entryUsd: ENTRY,
        exitPriceUsd: ENTRY * 1.05,
        feesPaidUsd: 0.011553,
      }).act,
    ).toBe("hold");
  });

  it("a flat position holds rather than sending a zero-size order", () => {
    const d = shouldExit({
      signedSize: 0,
      entryUsd: 0,
      exitPriceUsd: 0.0225,
      feesPaidUsd: 0,
    });
    expect(d.act).toBe("hold");
    if (d.act === "hold") expect(d.why).toBe("flat");
  });
});

describe("where 5273 stands right now", () => {
  it("holds at the current bid — it is net down", () => {
    const d = shouldExit(live(0.021474));
    expect(d.act).toBe("hold");
    expect(d.math.netUsd).toBeLessThan(0);
  });
});
