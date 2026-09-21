import { describe, expect, it } from "vitest";
import {
  GAS_CEILING,
  GAS_FALLBACK,
  GAS_MIN,
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

// Gas figures below are mainnet measurements taken 2026-09-20 over 25 quotes,
// not invented constants. MEASURED_* are what routes actually consume; if a
// future change moves the policy so these pay more than they used to, these
// tests are the thing that notices.
const MEASURED_BOOK = 387_000n; // the usual route, very stable across sizes
const MEASURED_CHEAPEST = 311_949n; // single-hop pool
const MEASURED_WORST = 622_414n; // tx 0x95f14269…2bb0, re-estimated at its own block
const OLD_FLAT_FLOOR = 900_000n; // what every trade used to pay, whatever it needed

describe("gasFor — the estimate must actually decide", () => {
  it("charges a book route far less than the old flat floor", () => {
    // THE REGRESSION THIS FILE EXISTS FOR. The previous floor sat above every
    // padded estimate, so the estimate was dead code and a 5 MON sale paid
    // 1.9% of notional in gas — worse than the swap desk it was built to beat.
    const g = gasFor(MEASURED_BOOK);
    expect(g).toBe(580_500n);
    expect(g).toBeLessThan(OLD_FLAT_FLOOR);
  });

  it("still covers the worst route ever measured", () => {
    // The safety argument has to survive the change: the heaviest observed
    // path is a three-hop v4+v3+v2 route, and it must not get tighter than it
    // was. 622,414 x 1.5 lands on 933,621 — the exact limit that route was
    // actually sent with, and it executed.
    expect(gasFor(MEASURED_WORST)).toBe(933_621n);
    expect(gasFor(MEASURED_WORST)).toBeGreaterThan(MEASURED_WORST);
  });

  it("pads enough to absorb Monad's asynchronous execution", () => {
    // Estimating the same calldata against `latest` rather than its execution
    // block moved by 5.6%, because the simulation runs ~3 blocks ahead and a
    // fill crossing different book levels costs different gas. 1.5x covers
    // that roughly nine times over.
    const drift = (MEASURED_WORST * 106n) / 100n;
    expect(gasFor(MEASURED_WORST)).toBeGreaterThan(drift);
  });

  it("falls back only when there is no estimate at all", () => {
    expect(gasFor(null)).toBe(GAS_FALLBACK);
    expect(gasFor(0n)).toBe(GAS_FALLBACK);
    expect(gasFor(-1n)).toBe(GAS_FALLBACK);
    // Blind means blind: it has to cover the worst route unaided.
    expect(GAS_FALLBACK).toBeGreaterThan(MEASURED_WORST);
  });

  it("clamps an absurdly low estimate without reverting on purpose", () => {
    expect(gasFor(1n)).toBe(GAS_MIN);
    expect(gasFor(120_000n)).toBe(GAS_MIN);
  });

  it("caps a pathological estimate so one trade cannot drain a wallet", () => {
    expect(gasFor(10_000_000n)).toBe(GAS_CEILING);
  });

  it("keeps the guards out of the way of every route measured", () => {
    // GAS_MIN is a sanity check, not a tax: it must not bind on real traffic.
    // GAS_CEILING must not clip the worst real route either.
    for (const m of [MEASURED_CHEAPEST, MEASURED_BOOK, MEASURED_WORST]) {
      expect(gasFor(m)).toBe((m * 3n) / 2n);
    }
  });

  it("is monotonic — a bigger estimate never yields a smaller limit", () => {
    let prev = 0n;
    for (const e of [1n, 100_000n, 311_949n, 387_000n, 622_414n, 9_000_000n]) {
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
