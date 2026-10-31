import { describe, expect, it } from "vitest";
import { decodeAbiParameters, decodeFunctionData } from "viem";
import {
  MON_AUSD_POOL_ID,
  MON_AUSD_POOL_KEY,
  UNIVERSAL_ROUTER,
  UNIVERSAL_ROUTER_ABI,
  buildMonToAusdSwap,
  poolIdOf,
  v4GasLimit,
  v4MinOut,
} from "./uniswap-v4";
import { AUSD } from "./kuru";

const MON = (n: number) => BigInt(n) * 10n ** 18n;

describe("the pool", () => {
  it("the key hashes to the pool a real September swap filled in", () => {
    // Pool id read off tx 0x1bae5785… logs; tick spacing 1 is the only spacing
    // that produces it (10 and 60 were checked and do not).
    expect(poolIdOf(MON_AUSD_POOL_KEY)).toBe(MON_AUSD_POOL_ID);
  });
});

describe("buildMonToAusdSwap", () => {
  const tx = buildMonToAusdSwap({ monWei: MON(843), minAusdOut: 16_000_000n, deadlineSec: 1_000n });

  it("pays the router with the swap's own value, nothing more", () => {
    expect(tx.to).toBe(UNIVERSAL_ROUTER);
    expect(tx.value).toBe(MON(843));
  });

  it("decodes back to exactly one V4_SWAP of SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL", () => {
    const d = decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data: tx.data });
    const [commands, inputs, deadline] = d.args;
    expect(commands).toBe("0x10");
    expect(deadline).toBe(1_000n);
    expect(inputs).toHaveLength(1);
    const [actions, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], inputs[0]);
    expect(actions).toBe("0x060c0f");
    expect(params).toHaveLength(3);

    const [swap] = decodeAbiParameters(
      [{ type: "tuple", components: [
        { name: "poolKey", type: "tuple", components: [
          { name: "currency0", type: "address" }, { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] },
        { name: "zeroForOne", type: "bool" }, { name: "amountIn", type: "uint128" },
        { name: "amountOutMinimum", type: "uint128" }, { name: "hookData", type: "bytes" }] }],
      params[0],
    );
    expect(swap.poolKey).toEqual(MON_AUSD_POOL_KEY);
    expect(swap.zeroForOne).toBe(true); // MON in, AUSD out
    expect(swap.amountIn).toBe(MON(843));
    expect(swap.amountOutMinimum).toBe(16_000_000n);

    const pair = [{ type: "address" }, { type: "uint256" }] as const;
    // SETTLE_ALL: native MON, capped at exactly the amount sold.
    expect(decodeAbiParameters(pair, params[1])).toEqual(["0x0000000000000000000000000000000000000000", MON(843)]);
    // TAKE_ALL: AUSD, at least the floor again.
    const [takeToken, takeMin] = decodeAbiParameters(pair, params[2]);
    expect(takeToken.toLowerCase()).toBe(AUSD.toLowerCase());
    expect(takeMin).toBe(16_000_000n);
  });

  it("refuses to build a swap with no minimum output — that accepts any price", () => {
    expect(() => buildMonToAusdSwap({ monWei: MON(1), minAusdOut: 0n, deadlineSec: 1n })).toThrow(/no minimum/);
  });
  it("refuses a zero amount", () => {
    expect(() => buildMonToAusdSwap({ monWei: 0n, minAusdOut: 1n, deadlineSec: 1n })).toThrow(/zero/);
  });
});

describe("v4MinOut", () => {
  it("1% under the live 843 MON quote (16.188 AUSD), rounded down", () => {
    expect(v4MinOut(16_188_400n, 100)).toBe(16_026_516n);
  });
  it("refuses nonsense slippage", () => {
    expect(() => v4MinOut(1n, -1)).toThrow();
    expect(() => v4MinOut(1n, 10_000)).toThrow();
  });
});

describe("v4GasLimit", () => {
  it("pads the measured 843 MON estimate 1.5x", () => {
    expect(v4GasLimit(202_929n)).toBe(304_393n);
  });
  it("caps it, and refuses to guess without an estimate", () => {
    expect(v4GasLimit(10_000_000n)).toBe(600_000n);
    expect(() => v4GasLimit(0n)).toThrow();
  });
});
