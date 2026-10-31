import { describe, expect, it } from "vitest";
import {
  KURU_ACCOUNT_CORE,
  KURU_MON_USDC,
  KuruStopped,
  NATIVE_MON,
  checkFill,
  gasLimitFor,
  V2_STEP_GAS_CEILING,
  V2_TRADE_GAS,
  v2GasReserveWei,
  legsFor,
  minAmountOut,
  swapOnKuru,
  withdrawAll,
  type KuruChain,
} from "./kuru-v2";
import { USDC } from "./kuru";

const OWNER = "0xE2ab465839E409C80D1CA4bB4508feA7Eb808395" as const;
const MON = (n: number) => BigInt(n) * 10n ** 18n;

// Read off mainnet 2026-10-31, `cast call 0xc9dE…405D estimateSwap(bool,uint128)`:
// selling 843 MON on the new MONUSDC book returned exactly this.
const LIVE_843 = { amountInUsed: MON(843), amountOut: 16_569_222n };

interface Call {
  kind: "read" | "send";
  address: string;
  fn: string;
  args: readonly unknown[];
  value?: bigint;
}

/** A chain that answers from a script and records every call in order. */
function fakeChain(opts: {
  estimate?: { amountInUsed: bigint; amountOut: bigint };
  rootId?: number;
  balances?: Record<string, bigint>;
  allowance?: bigint;
  failSend?: string;
}): KuruChain & { calls: Call[] } {
  const calls: Call[] = [];
  let rootId = opts.rootId ?? 0;
  const est = opts.estimate ?? LIVE_843;
  return {
    calls,
    read: async (c) => {
      calls.push({
        kind: "read",
        address: c.address,
        fn: c.functionName,
        args: c.args,
      });
      switch (c.functionName) {
        case "estimateSwap":
          return est;
        case "rootAccountIdOf":
          return rootId;
        case "getBalance":
          return opts.balances?.[String(c.args[1]).toLowerCase()] ?? 0n;
        case "allowance":
          return opts.allowance ?? 0n;
      }
      throw new Error(`unexpected read ${c.functionName}`);
    },
    send: async (c) => {
      calls.push({
        kind: "send",
        address: c.address,
        fn: c.functionName,
        args: c.args,
        value: c.value,
      });
      if (opts.failSend === c.functionName)
        throw new Error(`${c.functionName} reverted`);
      if (c.functionName === "deposit" && rootId === 0) rootId = 7;
      return `0x${c.functionName}` as `0x${string}`;
    },
  };
}

const sends = (c: { calls: Call[] }) =>
  c.calls.filter((x) => x.kind === "send").map((x) => x.fn);

describe("minAmountOut", () => {
  it("takes 1% off the live 843 MON quote, rounding down", () => {
    expect(minAmountOut(LIVE_843.amountOut, 100)).toBe(16_403_529n);
  });
  it("refuses a nonsense slippage", () => {
    expect(() => minAmountOut(1n, -1)).toThrow();
    expect(() => minAmountOut(1n, 10_000)).toThrow();
    expect(() => minAmountOut(1n, 1.5)).toThrow();
  });
});

describe("checkFill", () => {
  it("passes the live quote", () => {
    expect(() => checkFill(LIVE_843, MON(843))).not.toThrow();
  });
  it("refuses an empty book (what the old 0x065c9d28 market had)", () => {
    expect(() =>
      checkFill({ amountInUsed: 0n, amountOut: 0n }, MON(843)),
    ).toThrow(/nothing to trade/);
  });
  it("refuses a partial fill rather than strand the rest in Kuru", () => {
    expect(() =>
      checkFill({ amountInUsed: MON(400), amountOut: 7_862_027n }, MON(843)),
    ).toThrow(/only fill/);
  });
});

describe("legsFor", () => {
  it("sell spends native MON on the book's ask side", () => {
    expect(legsFor("sell")).toEqual({
      tokenIn: NATIVE_MON,
      tokenOut: USDC,
      isBuy: false,
    });
  });
  it("buy spends USDC", () => {
    expect(legsFor("buy")).toEqual({
      tokenIn: USDC,
      tokenOut: NATIVE_MON,
      isBuy: true,
    });
  });
});

describe("swapOnKuru — sell MON", () => {
  it("deposits, swaps, withdraws, in that order, with the right arguments", async () => {
    const chain = fakeChain({
      balances: { [USDC.toLowerCase()]: 16_570_000n },
    });
    const r = await swapOnKuru({
      chain,
      owner: OWNER,
      side: "sell",
      amountIn: MON(843),
      nowSec: 1_000,
    });
    expect(sends(chain)).toEqual(["deposit", "swap", "withdraw"]);

    const [deposit, swap, withdraw] = chain.calls.filter(
      (c) => c.kind === "send",
    );
    // Native MON travels as value, and the account is created for the owner.
    expect(deposit.address).toBe(KURU_ACCOUNT_CORE);
    expect(deposit.args).toEqual([OWNER, NATIVE_MON, MON(843)]);
    expect(deposit.value).toBe(MON(843));
    // The swap uses the account id that exists AFTER the deposit.
    expect(swap.address).toBe(KURU_MON_USDC);
    expect(swap.args).toEqual([7, false, MON(843), 16_403_529n, 1_120n]);
    // The proceeds go back to the owner's own wallet.
    expect(withdraw.args).toEqual([7, USDC, 16_570_000n, OWNER]);
    expect(r.amountOut).toBe(16_570_000n);
  });

  it("re-quotes after the deposit rather than trusting the first quote", async () => {
    const chain = fakeChain({});
    await swapOnKuru({
      chain,
      owner: OWNER,
      side: "sell",
      amountIn: MON(843),
    }).catch(() => {});
    const order = chain.calls.map((c) => c.fn);
    expect(order.indexOf("estimateSwap")).toBeLessThan(
      order.indexOf("deposit"),
    );
    expect(order.lastIndexOf("estimateSwap")).toBeGreaterThan(
      order.indexOf("deposit"),
    );
  });

  it("sends nothing when the book cannot fill it", async () => {
    const chain = fakeChain({ estimate: { amountInUsed: 0n, amountOut: 0n } });
    const err = await swapOnKuru({
      chain,
      owner: OWNER,
      side: "sell",
      amountIn: MON(843),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KuruStopped);
    expect((err as KuruStopped).nothingSent).toBe(true);
    expect((err as KuruStopped).inKuru).toBe(false);
    expect(sends(chain)).toEqual([]);
  });

  it("says the MON is IN KURU when the swap fails after the deposit", async () => {
    const chain = fakeChain({ failSend: "swap" });
    const err = (await swapOnKuru({
      chain,
      owner: OWNER,
      side: "sell",
      amountIn: MON(843),
    }).catch((e: unknown) => e)) as KuruStopped;
    expect(err.stage).toBe("swapping");
    expect(err.inKuru).toBe(true);
    expect(err.nothingSent).toBe(false);
    // Does not try to withdraw on its own — the hunter decides.
    expect(sends(chain)).toEqual(["deposit", "swap"]);
  });

  it("does not claim to know where the MON is when the deposit throws", async () => {
    const chain = fakeChain({ failSend: "deposit" });
    const err = (await swapOnKuru({
      chain,
      owner: OWNER,
      side: "sell",
      amountIn: MON(843),
    }).catch((e: unknown) => e)) as KuruStopped;
    expect(err.stage).toBe("depositing");
    expect(err.inKuru).toBeNull();
    expect(err.nothingSent).toBe(false);
  });

  it("reports the swap hash before attempting the withdrawal", async () => {
    const seen: string[] = [];
    const chain = fakeChain({ failSend: "withdraw" });
    const err = (await swapOnKuru({
      chain,
      owner: OWNER,
      side: "sell",
      amountIn: MON(843),
      onSwapTx: (h) => seen.push(h),
    }).catch((e: unknown) => e)) as KuruStopped;
    expect(seen).toEqual(["0xswap"]);
    expect(err.stage).toBe("withdrawing");
    expect(err.inKuru).toBe(true);
  });
});

describe("swapOnKuru — buy MON with USDC", () => {
  it("approves exactly the amount, deposits with no value, swaps as a buy", async () => {
    const chain = fakeChain({
      estimate: { amountInUsed: 5_000_000n, amountOut: MON(250) },
      balances: { [NATIVE_MON]: MON(250) },
    });
    await swapOnKuru({
      chain,
      owner: OWNER,
      side: "buy",
      amountIn: 5_000_000n,
    });
    expect(sends(chain)).toEqual(["approve", "deposit", "swap", "withdraw"]);
    const [approve, deposit, swap] = chain.calls.filter(
      (c) => c.kind === "send",
    );
    expect(approve.args).toEqual([KURU_ACCOUNT_CORE, 5_000_000n]);
    expect(deposit.value).toBe(0n);
    expect(swap.args[1]).toBe(true);
  });

  it("skips the approval when the allowance already covers it", async () => {
    const chain = fakeChain({
      estimate: { amountInUsed: 5_000_000n, amountOut: MON(250) },
      allowance: 5_000_000n,
    });
    await swapOnKuru({
      chain,
      owner: OWNER,
      side: "buy",
      amountIn: 5_000_000n,
    });
    expect(sends(chain)[0]).toBe("deposit");
  });
});

describe("withdrawAll — the way out", () => {
  it("withdraws every nonzero balance to the owner", async () => {
    const chain = fakeChain({
      rootId: 7,
      balances: { [NATIVE_MON]: MON(843), [USDC.toLowerCase()]: 0n },
    });
    const sent = await withdrawAll({ chain, owner: OWNER });
    expect(sent).toHaveLength(1);
    const w = chain.calls.find((c) => c.fn === "withdraw");
    expect(w?.args).toEqual([7, NATIVE_MON, MON(843), OWNER]);
  });

  it("does nothing for a wallet with no Kuru account", async () => {
    const chain = fakeChain({ rootId: 0 });
    expect(await withdrawAll({ chain, owner: OWNER })).toEqual([]);
    expect(sends(chain)).toEqual([]);
  });
});

describe("gasLimitFor", () => {
  it("pads the live estimate 1.5x — Monad charges the limit, and state drifts", () => {
    // The measured swap step.
    expect(gasLimitFor(389_010n)).toBe(583_515n);
  });
  it("caps a runaway estimate", () => {
    expect(gasLimitFor(5_000_000n)).toBe(V2_STEP_GAS_CEILING);
  });
  it("refuses to guess without an estimate", () => {
    expect(() => gasLimitFor(0n)).toThrow();
  });
  it("the trade reserve covers the heaviest measured trade, padded", () => {
    expect(V2_TRADE_GAS).toBeGreaterThanOrEqual((1_196_755n * 3n) / 2n);
  });
});

describe("v2GasReserveWei", () => {
  it("at today's 102 gwei holds back about 0.23 MON", () => {
    expect(v2GasReserveWei(102_000_000_000n)).toBe(229_500_000_000_000_000n);
  });
});
