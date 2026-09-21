import { describe, expect, it } from "vitest";
import {
  GAS_FLOOR,
  explainFailure,
  gasFor,
  quoteAcceptable,
  received,
  shouldRetry,
} from "./spot-trade";

// ---------------------------------------------------------------------------
// These rules were written inline in a React component, and then a trade
// reverted on a real phone and not one of them could be asked a question. Each
// test below corresponds to a failure that actually happened or that the code
// got wrong on the first pass.
// ---------------------------------------------------------------------------

const WORDS = {
  noRoute: "Kuru returned no route that would execute. Try again.",
  revertedTx: "The trade reverted on-chain:",
};

describe("gasFor — Monad charges the whole limit on revert", () => {
  it("never goes below the limit every working send has used", () => {
    // The trap: a tight estimate does not save gas here, it buys a failed
    // transaction at full price. viem's estimate is what the reverting version
    // of this screen used.
    expect(gasFor(120_000n)).toBe(GAS_FLOOR);
    expect(gasFor(null)).toBe(GAS_FLOOR);
    expect(gasFor(0n)).toBe(GAS_FLOOR);
  });

  it("adds headroom when the estimate is already above the floor", () => {
    expect(gasFor(1_000_000n)).toBe(1_500_000n);
  });

  it("is monotonic — a bigger estimate never yields a smaller limit", () => {
    let prev = 0n;
    for (const e of [1n, 100_000n, 600_000n, 900_000n, 2_000_000n]) {
      const g = gasFor(e);
      expect(g).toBeGreaterThanOrEqual(prev);
      prev = g;
    }
  });
});

describe("received — measured, not quoted", () => {
  it("is the balance difference", () => {
    expect(received(1000n, 1250n)).toBe(250n);
  });

  it("clamps to zero when gas cost exceeded what arrived", () => {
    // Real on a small MON buy: the trade succeeds and the wallet still goes
    // down, because the gas outweighed the MON bought. A negative "you
    // received" is a number nobody can act on.
    expect(received(1000n, 900n)).toBe(0n);
    expect(received(1000n, 1000n)).toBe(0n);
  });
});

describe("shouldRetry — a revert is as retryable as a failed simulation", () => {
  const revert = { kind: "reverted" as const, hash: "0xabc" as `0x${string}` };
  const simFail = { kind: "simulation-failed" as const };

  it("retries a REVERT, which the first version did not", () => {
    // The bug this pins: it threw on the first revert while identical retry
    // logic sat one branch away, so a hunter saw a dead end on a trade that
    // would have worked on the next tap.
    expect(shouldRetry(revert, 0, 4)).toBe(true);
  });

  it("retries a failed simulation", () => {
    expect(shouldRetry(simFail, 0, 4)).toBe(true);
  });

  it("stops once the attempts are spent", () => {
    expect(shouldRetry(revert, 3, 4)).toBe(false);
    expect(shouldRetry(simFail, 3, 4)).toBe(false);
  });

  it("never retries a success", () => {
    const sent = { kind: "sent" as const, hash: "0xdef" as `0x${string}` };
    expect(shouldRetry(sent, 0, 4)).toBe(false);
  });
});

describe("explainFailure — keep the hash", () => {
  it("names the reverted transaction so it can be opened", () => {
    const f = explainFailure(
      "0x1ae095d115cc77a1f7ddc06634a695e4" as `0x${string}`,
      WORDS,
    );
    expect(f.hash).toBe("0x1ae095d115cc77a1f7ddc06634a695e4");
    expect(f.message).toContain("0x1ae095d1");
  });

  it("distinguishes 'nothing simulated' from 'it reverted'", () => {
    // Different causes, different fixes. Collapsing them into one word is what
    // made the phone report unactionable.
    const none = explainFailure(null, WORDS);
    expect(none.hash).toBeNull();
    expect(none.message).toBe(WORDS.noRoute);
    expect(none.message).not.toContain("0x");
  });
});

describe("quoteAcceptable", () => {
  const q = (output: bigint, minOut: bigint, usesOrderBook = true) => ({
    output,
    minOut,
    usesOrderBook,
  });

  it("refuses a zero output", () => {
    expect(quoteAcceptable(q(0n, 0n))).toBe(false);
  });

  it("refuses a minOut above the quote — it can only revert", () => {
    expect(quoteAcceptable(q(100n, 101n))).toBe(false);
  });

  it("accepts a pool route by default, because price beats the label", () => {
    // Refusing this would hand the hunter a worse price to protect a pill.
    expect(quoteAcceptable(q(100n, 99n, false))).toBe(true);
  });

  it("can be made to demand the order book when the label is the point", () => {
    expect(
      quoteAcceptable(q(100n, 99n, false), { requireOrderBook: true }),
    ).toBe(false);
    expect(
      quoteAcceptable(q(100n, 99n, true), { requireOrderBook: true }),
    ).toBe(true);
  });
});
