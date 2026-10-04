import { describe, expect, it, vi } from "vitest";
import { runPlan, strandedAfter, type Runners } from "./oneclick-run";
import type { Step } from "./oneclick";

const explain = (step: Step, err: unknown) => `${step}: ${String(err)}`;

const runners = (over: Partial<Runners> = {}): Runners => ({
  swap: vi.fn(async () => "0xswap"),
  deposit: vi.fn(async () => "0xdeposit"),
  leash: vi.fn(async () => "0xleash"),
  trade: vi.fn(async () => "0xtrade"),
  ...over,
});

describe("runPlan", () => {
  it("runs every step in order and reports each hash", async () => {
    const r = runners();
    const out = await runPlan(
      ["swap", "deposit", "leash", "trade"],
      r,
      explain,
    );
    expect(out.ok).toBe(true);
    expect(out.failedAt).toBeNull();
    expect(out.outcomes.map((o) => o.step)).toEqual([
      "swap",
      "deposit",
      "leash",
      "trade",
    ]);
    expect(out.outcomes.every((o) => o.ok)).toBe(true);
  });

  it("STOPS at the first failure instead of spending another gas limit", async () => {
    // On Monad the whole gas limit is charged whether the call succeeds or not,
    // so attempting the deposit after a failed swap costs real money to learn
    // nothing. The later runners must not be called at all.
    const r = runners({
      swap: vi.fn(async () => {
        throw new Error("desk out of AUSD");
      }),
    });
    const out = await runPlan(
      ["swap", "deposit", "leash", "trade"],
      r,
      explain,
    );
    expect(out.ok).toBe(false);
    expect(out.failedAt).toBe("swap");
    expect(out.outcomes).toHaveLength(1);
    expect(r.deposit).not.toHaveBeenCalled();
    expect(r.leash).not.toHaveBeenCalled();
    expect(r.trade).not.toHaveBeenCalled();
  });

  it("keeps the successful steps on the record when a later one fails", async () => {
    const r = runners({
      deposit: vi.fn(async () => {
        throw new Error("reverted");
      }),
    });
    const out = await runPlan(["swap", "deposit", "trade"], r, explain);
    expect(out.failedAt).toBe("deposit");
    expect(out.outcomes[0]).toMatchObject({
      step: "swap",
      ok: true,
      hash: "0xswap",
    });
    expect(out.outcomes[1].ok).toBe(false);
    expect(out.outcomes[1].error).toContain("reverted");
  });

  it("runs only the steps it was given", async () => {
    const r = runners();
    const out = await runPlan(["trade"], r, explain);
    expect(out.ok).toBe(true);
    expect(r.swap).not.toHaveBeenCalled();
    expect(r.deposit).not.toHaveBeenCalled();
  });

  it("treats an empty plan as nothing to do rather than a failure", async () => {
    const out = await runPlan([], runners(), explain);
    expect(out.ok).toBe(true);
    expect(out.outcomes).toEqual([]);
  });
});

describe("strandedAfter — where the money actually is", () => {
  it("says the AUSD is in the wallet when the deposit failed after a swap", async () => {
    const out = await runPlan(
      ["swap", "deposit", "trade"],
      runners({
        deposit: vi.fn(async () => {
          throw new Error("reverted");
        }),
      }),
      explain,
    );
    for (const lang of ["en", "es"] as const) {
      const msg = strandedAfter(out, lang);
      expect(msg).toBeTruthy();
      // The one thing it must never do on this path is imply nothing happened.
      expect(msg).toMatch(lang === "en" ? /AUSD/ : /AUSD/);
      expect(msg).toMatch(lang === "en" ? /safe/i : /a salvo/i);
    }
  });

  it("says nothing was swapped when the swap itself failed", async () => {
    const out = await runPlan(
      ["swap", "deposit"],
      runners({
        swap: vi.fn(async () => {
          throw new Error("desk out of AUSD");
        }),
      }),
      explain,
    );
    // Must NOT assert the MON is safe: the swap is two legs and the first may
    // have landed. It said "nothing was swapped" to someone who had just sold
    // 1,414 MON in leg 1.
    const msg = strandedAfter(out, "en") ?? "";
    expect(msg).toMatch(/two legs/i);
    expect(msg).not.toMatch(/nothing was swapped/i);
    expect(msg).toMatch(/check your balance/i);
  });

  it("says the collateral is already at Perpl when only the trade failed", async () => {
    const out = await runPlan(
      ["deposit", "trade"],
      runners({
        trade: vi.fn(async () => {
          throw new Error("rejected");
        }),
      }),
      explain,
    );
    expect(strandedAfter(out, "en")).toMatch(/already deposited at Perpl/i);
  });

  it("says nothing at all when the run succeeded", async () => {
    const out = await runPlan(["trade"], runners(), explain);
    expect(strandedAfter(out, "en")).toBeNull();
    expect(strandedAfter(out, "es")).toBeNull();
  });
});
