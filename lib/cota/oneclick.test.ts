import { describe, expect, it } from "vitest";
import {
  ausdLabel,
  monToYieldAusd,
  monForAusd,
  monLabel,
  planOneClick,
  type Balances,
  type Conditions,
} from "./oneclick";

// ---------------------------------------------------------------------------
// Pinned to the real situation on 2026-10-04, not to convenient round numbers.
//
//   MON                     $0.034098 (ask, live book)
//   Perpl min_deposit       10000000 at 6dp = $10, from their own context
//   Perpl min_account_open  the same $10
//   a spawn                 1 MON, which is 3.4 cents
//   daily cap per player    20 MON, which is 68 cents
//
// The gap those four numbers describe is the whole reason this module exists,
// so the tests state it out loud rather than testing a tidier world.
// ---------------------------------------------------------------------------

const MON_USD = 0.034098;
const TEN_DOLLARS = 10_000_000n;
const WEI = 10n ** 18n;

/** Gas across swap + deposit, measured generously. Passed in, never assumed. */
const GAS = (15n * WEI) / 100n; // 0.15 MON

const base: Conditions = {
  enrolled: true,
  hasLeash: false,
  monUsd: MON_USD,
  minDeposit6: TEN_DOLLARS,
  minTrade6: TEN_DOLLARS,
  gasReserveWei: GAS,
  slippageBps: 100n,
  leashMaxNotional6: null,
  oneClickNotional6: 50_000_000n,
  minFillable6: 3_000_000n,
};

const empty: Balances = {
  walletMonWei: 0n,
  walletAusd6: 0n,
  perplAusd6: 0n,
};

describe("monForAusd", () => {
  it("prices $10 of AUSD at about 296 MON including 1% slippage", () => {
    const wei = monForAusd(TEN_DOLLARS, MON_USD, 100n);
    const mon = Number(wei) / 1e18;
    expect(mon).toBeGreaterThan(295);
    expect(mon).toBeLessThan(297);
  });

  it("rounds UP, because landing under Perpl's floor wastes the gas", () => {
    // A swap that returns a hair less than the floor leaves the hunter holding
    // AUSD they cannot deposit, having paid for the privilege. Overshooting
    // costs them nothing: the remainder is still their AUSD.
    const exact = monForAusd(1_000_000n, 1, 0n);
    expect(exact).toBe(WEI);
    const up = monForAusd(1_000_001n, 1, 0n);
    expect(up).toBeGreaterThan(WEI);
  });

  it("never returns an amount that converts back to less than it must buy", () => {
    // The invariant, rather than a spot check: whatever MON this hands back,
    // selling it at the same price must reach the target. A floor division
    // lands a wei short, the deposit misses Perpl's $10 by a hundredth of a
    // cent, and the hunter has paid gas to be refused.
    const prices = [0.034098, 0.0341, 1, 0.000003, 123.456];
    const targets = [1n, 999_999n, 1_000_000n, TEN_DOLLARS, 123_456_789n];
    for (const price of prices) {
      const priceE6 = BigInt(Math.ceil(price * 1e6));
      for (const target of targets) {
        const wei = monForAusd(target, price, 0n);
        // AUSD obtained = wei * priceE6 / 1e18, floored as a venue would.
        const back = (wei * priceE6) / WEI;
        expect(
          back >= target,
          `${target} at ${price} came back as ${back}`,
        ).toBe(true);
      }
    }
  });

  it("refuses a price that is zero, negative or not a number", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => monForAusd(TEN_DOLLARS, bad, 0n)).toThrow(RangeError);
    }
  });
});

describe("planOneClick — the hunter who just collected one spawn", () => {
  it("is short by about 295 MON after a single 1 MON claim", () => {
    const r = planOneClick({ ...empty, walletMonWei: WEI }, base);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("short");
      const short = Number(r.shortfallMonWei) / 1e18;
      // One claim is 3.4 cents against a $10 floor. This is the number the
      // screen has to show honestly instead of offering a button that fails.
      expect(short).toBeGreaterThan(294);
      expect(short).toBeLessThan(297);
    }
  });

  it("is still short after a full day at the 20 MON cap", () => {
    const r = planOneClick({ ...empty, walletMonWei: 20n * WEI }, base);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("short");
  });

  it("clears once the wallet holds enough, and says what it will do", () => {
    const r = planOneClick({ ...empty, walletMonWei: 300n * WEI }, base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.steps).toEqual(["swap", "deposit", "leash", "trade"]);
      // ONLY what Perpl's floor requires. The rest of the 300 MON stays in
      // the wallet: an earlier version deployed the whole balance and sold
      // 1,629 MON belonging to someone who had just topped up.
      expect(r.depositAusd6).toBe(TEN_DOLLARS);
      expect(r.tradeAusd6).toBe(TEN_DOLLARS);
      expect(r.swapMonWei).toBeGreaterThan(0n);
      expect(r.swapMonWei).toBeLessThan(300n * WEI - GAS);
    }
  });
});

describe("planOneClick — skipping what is already done", () => {
  it("skips the swap when the wallet already holds the AUSD", () => {
    const r = planOneClick(
      { walletMonWei: WEI, walletAusd6: TEN_DOLLARS, perplAusd6: 0n },
      base,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      // The AUSD already covers the deposit, so no MON is touched at all.
      expect(r.steps).toEqual(["deposit", "leash", "trade"]);
      expect(r.swapMonWei).toBe(0n);
      expect(r.depositAusd6).toBe(TEN_DOLLARS);
    }
  });

  it("skips swap and deposit when Perpl already holds the collateral", () => {
    // Gas is still needed, because the leash below it anchors on chain. This
    // case originally passed walletMonWei: 0 and expected a plan — written
    // while the leash was believed to be free. It is not, and the version of
    // this test that asserted otherwise would have shipped the belief.
    const r = planOneClick(
      { walletMonWei: GAS, walletAusd6: 0n, perplAusd6: 12_000_000n },
      base,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.steps).toEqual(["leash", "trade"]);
      expect(r.swapMonWei).toBe(0n);
      expect(r.depositAusd6).toBe(0n);
      expect(r.tradeAusd6).toBe(12_000_000n);
    }
  });

  it("is a single trade step when funded and already leashed", () => {
    const r = planOneClick(
      { ...empty, perplAusd6: 12_000_000n },
      { ...base, hasLeash: true },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.steps).toEqual(["trade"]);
  });

  it("never skips the leash to save a step", () => {
    // The leash is what bounds everything the agent may later do. A button that
    // traded without one would be the product contradicting its own thesis, so
    // it appears in every plan that ends in a trade without one already live.
    const r = planOneClick({ ...empty, walletMonWei: 400n * WEI }, base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.steps).toContain("leash");
  });
});

describe("planOneClick — Perpl's floor is not a suggestion", () => {
  it("deposits the whole $10 to cover a $2 shortfall", () => {
    // Perpl has no top-up below min_deposit_amount. Asking for the difference
    // would be refused at the venue, so the plan asks for the floor.
    const r = planOneClick({ ...empty, perplAusd6: 8_000_000n }, {
      ...base,
      walletMonWei: 0n,
    } as Conditions);
    expect(r.ok).toBe(false); // no MON to buy it with
    const funded = planOneClick(
      { walletMonWei: 400n * WEI, walletAusd6: 0n, perplAusd6: 8_000_000n },
      base,
    );
    expect(funded.ok).toBe(true);
    if (funded.ok) {
      // Perpl has no top-up below its floor, so a $2 shortfall still costs a
      // $10 deposit — and not a wei of the remaining wallet.
      expect(funded.depositAusd6).toBe(TEN_DOLLARS);
      expect(funded.tradeAusd6).toBe(18_000_000n);
    }
  });
});

describe("planOneClick — gas is reserved, not borrowed from the swap", () => {
  it("adds the reserve on top of the swap rather than hoping for change", () => {
    // The inverse of the conversion the planner checks against, not
    // monForAusd — the two round opposite ways and a round trip lands short.
    const need = monToYieldAusd(TEN_DOLLARS, MON_USD, 100n);
    // Exactly the swap amount and not a wei more: there is nothing left to pay
    // gas with, so the plan must refuse rather than strand them mid-sequence.
    const justSwap = planOneClick({ ...empty, walletMonWei: need }, base);
    // Exactly the swap amount leaves nothing to pay the gas with.
    expect(justSwap.ok).toBe(false);

    const withGas = planOneClick({ ...empty, walletMonWei: need + GAS }, base);
    expect(withGas.ok).toBe(true);
  });

  it("still demands gas when no swap is needed, because deposit costs gas too", () => {
    const r = planOneClick(
      { walletMonWei: 0n, walletAusd6: TEN_DOLLARS, perplAusd6: 0n },
      base,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.shortfallMonWei).toBe(GAS);
  });
});

describe("planOneClick — reasons that are not money", () => {
  it("blocks on enrolment before looking at balances at all", () => {
    const r = planOneClick(
      { walletMonWei: 10_000n * WEI, walletAusd6: 0n, perplAusd6: 0n },
      { ...base, enrolled: false },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("not_enrolled");
      expect(r.shortfallMonWei).toBe(0n);
    }
  });
});

describe("labels", () => {
  it("renders MON and AUSD without inventing precision", () => {
    expect(monLabel(0n)).toBe("0.00");
    expect(monLabel(WEI)).toBe("1.00");
    expect(monLabel((1234n * WEI) / 100n)).toBe("12.34");
    expect(ausdLabel(0n)).toBe("0.00");
    expect(ausdLabel(TEN_DOLLARS)).toBe("10.00");
    expect(ausdLabel(12_345_678n)).toBe("12.34");
  });
});

describe("planOneClick — the leash costs gas too", () => {
  it("demands gas for a funded hunter who still has to sign a leash", () => {
    // signAndAnchorCota does not just sign: it anchors the digest on Monad, so
    // the leash is a transaction. A first version of this module treated it as
    // free, which would have let someone through with exactly enough for the
    // swap and the deposit and then produced a leash whose anchor failed —
    // silently, because sign.ts tolerates an anchor failure on purpose so a bad
    // moment cannot cost someone their signature.
    const r = planOneClick(
      { walletMonWei: 0n, walletAusd6: 0n, perplAusd6: 12_000_000n },
      base,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("short");
      expect(r.shortfallMonWei).toBe(GAS);
    }
  });

  it("needs nothing at all once the leash is already live", () => {
    // Funded, leashed, and the only step left goes over the enrolled key. No
    // transaction, so no MON required — a hunter in this state must not be told
    // they are short of anything.
    const r = planOneClick(
      { walletMonWei: 0n, walletAusd6: 0n, perplAusd6: 12_000_000n },
      { ...base, hasLeash: true },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.steps).toEqual(["trade"]);
  });
});

describe("planOneClick — the order must fit under the leash governing it", () => {
  const funded = (perpl: bigint) => ({
    walletMonWei: 400n * WEI,
    walletAusd6: 0n,
    perplAusd6: perpl,
  });

  it("clamps the order to a live leash's ceiling instead of bouncing off it", () => {
    // $50 of collateral under a $20 leash. Without the clamp every step would
    // run and the LAST one would be refused by the hunter's own ceiling —
    // money moved through three irreversible steps, no position, and the
    // refusal arriving from the one component whose job is to refuse.
    const r = planOneClick(funded(50_000_000n), {
      ...base,
      hasLeash: true,
      leashMaxNotional6: 20_000_000n,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Already past the trading minimum, so nothing is sold and nothing is
      // deposited — and the ORDER is still pinned to the $20 ceiling.
      expect(r.swapMonWei).toBe(0n);
      expect(r.tradeAusd6).toBe(50_000_000n);
      expect(r.orderNotional6).toBe(20_000_000n);
    }
  });

  it("sends the whole collateral when it already fits", () => {
    const r = planOneClick(funded(10_980_000n), {
      ...base,
      hasLeash: true,
      leashMaxNotional6: 20_000_000n,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // $10.98 at Perpl under a $20 leash goes out whole, and the 400 MON in
      // the wallet is not touched.
      expect(r.swapMonWei).toBe(0n);
      expect(r.orderNotional6).toBe(10_980_000n);
    }
  });

  it("sizes against the leash the press is ABOUT to sign when none is live", () => {
    const r = planOneClick(funded(80_000_000n), {
      ...base,
      hasLeash: false,
      leashMaxNotional6: null,
      oneClickNotional6: 50_000_000n,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.orderNotional6).toBe(50_000_000n);
  });

  it("refuses rather than sending an order the venue will not fill", () => {
    // A $1 MON market order filled 0 and returned TakerOrderSettlementFailed;
    // $3 filled fully. Under the floor is not a small trade, it is a failed one
    // — and finding that out after three irreversible steps is the worst place.
    const r = planOneClick(funded(12_000_000n), {
      ...base,
      hasLeash: true,
      leashMaxNotional6: 1_000_000n,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("below_min_order");
  });
});

describe("the shortfall must be a number that actually works", () => {
  it("lets a hunter through who comes back with exactly what they were told", () => {
    // The bug this guards: the shortfall was computed with monForAusd, which
    // ADDS the slippage allowance, while the sufficiency check uses ausdForMon,
    // which SUBTRACTS it. A hunter told "you need 295 MON" would return with
    // 295 and be refused again, for a reason nothing on screen could explain.
    const start = { ...empty, walletMonWei: 5n * WEI };
    const first = planOneClick(start, base);
    expect(first.ok).toBe(false);
    if (first.ok) return;

    // Exactly what they were asked for, and not a wei more.
    const after = planOneClick(
      { ...start, walletMonWei: start.walletMonWei + first.shortfallMonWei },
      base,
    );
    expect(after.ok).toBe(true);
  });

  it("holds for a range of starting balances and prices", () => {
    for (const price of [0.034098, 0.02, 0.1, 1.5]) {
      for (const start of [0n, WEI, 50n * WEI, 200n * WEI]) {
        const c = { ...base, monUsd: price };
        const r = planOneClick({ ...empty, walletMonWei: start }, c);
        if (r.ok) continue;
        if (r.reason !== "short") continue;
        const again = planOneClick(
          { ...empty, walletMonWei: start + r.shortfallMonWei },
          c,
        );
        expect(
          again.ok,
          `price ${price}, start ${start}: told to add ${r.shortfallMonWei} and still refused`,
        ).toBe(true);
      }
    }
  });
});

describe("planOneClick — dust is left alone", () => {
  it("does not sell MON worth less than the gas it costs to sell", () => {
    // Enough AUSD to deposit without touching the MON, and MON worth less than
    // the reserve. Selling it would make the hunter poorer in exchange for a
    // larger number on a screen — on Monad especially, where the whole gas
    // limit is charged whether the call needed it or not.
    const r = planOneClick(
      {
        walletMonWei: GAS + GAS / 4n,
        walletAusd6: 12_000_000n,
        perplAusd6: 0n,
      },
      base,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      // The AUSD covers the floor on its own, so no MON is sold.
      expect(r.steps).not.toContain("swap");
      expect(r.swapMonWei).toBe(0n);
      expect(r.depositAusd6).toBe(TEN_DOLLARS);
    }
  });
});

describe("planOneClick — it must never reach for the whole wallet", () => {
  it("leaves a large balance alone and sells only what the floor needs", () => {
    // THE REGRESSION. For about eight hours this deployed the entire spendable
    // balance. Someone transferred 1,604 MON in, pressed the button, and it
    // sold 1,629.33 MON — every MON they owned bar the gas — into 58.50 USDC.
    // Nothing was lost and nothing malfunctioned; the instruction was wrong.
    const rich = {
      walletMonWei: 1_629n * WEI,
      walletAusd6: 0n,
      perplAusd6: 0n,
    };
    const r = planOneClick(rich, base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.depositAusd6).toBe(TEN_DOLLARS);
      // About 296 MON for a $10 deposit, not 1,629.
      expect(r.swapMonWei).toBeLessThan(400n * WEI);
      // And most of it is still theirs afterwards.
      expect(rich.walletMonWei - r.swapMonWei).toBeGreaterThan(1_200n * WEI);
    }
  });

  it("sells nothing at all when the venue is already funded", () => {
    // The state the wallet was actually in: funded past the minimum. A press
    // here must not touch a single MON, however much is sitting there.
    const r = planOneClick(
      { walletMonWei: 1_629n * WEI, walletAusd6: 0n, perplAusd6: 10_980_000n },
      { ...base, hasLeash: true },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.swapMonWei).toBe(0n);
      expect(r.steps).toEqual(["trade"]);
    }
  });
});
