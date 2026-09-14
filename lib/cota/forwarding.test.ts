import { describe, expect, it } from "vitest";
import { encodeFunctionData } from "viem";
import { FORWARDING_ABI } from "./forwarding";

// The whole value of this module is that it calls the RIGHT function on the
// exchange. A renamed field or a widened argument type still compiles and still
// encodes — it just encodes a selector the contract does not have, and the
// hunter pays a full-gas-limit revert to find out (Monad refunds nothing).
//
// 0x7962f910 is `allowOrderForwarding(bool)`. It was read out of the live
// implementation's bytecode at 0xf7df187620c81deee0833589509f41f95886cd33
// (the EIP-1967 impl behind the exchange proxy 0x34b6552d…12a6f) on 2026-09-14,
// and a call simulated from the hunter's wallet returned 0x with a 71,363 gas
// estimate — so the selector is not merely present, it dispatches.
const ALLOW_ORDER_FORWARDING = "0x7962f910";

describe("allowOrderForwarding encoding", () => {
  it("encodes the selector the exchange actually dispatches", () => {
    const data = encodeFunctionData({
      abi: FORWARDING_ABI,
      functionName: "allowOrderForwarding",
      args: [true],
    });
    expect(data.slice(0, 10)).toBe(ALLOW_ORDER_FORWARDING);
  });

  it("encodes true and false distinguishably", () => {
    const on = encodeFunctionData({
      abi: FORWARDING_ABI,
      functionName: "allowOrderForwarding",
      args: [true],
    });
    const off = encodeFunctionData({
      abi: FORWARDING_ABI,
      functionName: "allowOrderForwarding",
      args: [false],
    });
    expect(on).toBe(ALLOW_ORDER_FORWARDING + "0".repeat(63) + "1");
    expect(off).toBe(ALLOW_ORDER_FORWARDING + "0".repeat(64));
  });
});
