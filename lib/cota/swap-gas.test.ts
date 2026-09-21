import { describe, expect, it } from "vitest";
import { SWAP_GAS_MEASURED, swapGasReserveWei } from "./swap";

// ---------------------------------------------------------------------------
// The swap desk's reserve was a flat 0.05 MON. Unlike the spot screen's, it was
// not broken — a swap costs 291,983 gas, so 0.0298 MON at the 102 gwei trades
// have been landing at. It was adequate by luck: 0.05 stops covering the swap
// at 171 gwei, and Kuru quotes 130 gwei "rapid" and 180 "extreme" today.
// ---------------------------------------------------------------------------

const OLD_FLAT = 50_000_000_000_000_000n; // parseEther("0.05")
const cost = (price: bigint) => SWAP_GAS_MEASURED * price;

describe("swapGasReserveWei", () => {
  it("covers the measured swap at the price trades actually land at", () => {
    expect(swapGasReserveWei(102_000_000_000n)).toBeGreaterThan(
      cost(102_000_000_000n),
    );
  });

  it("covers prices where the old flat reserve silently stopped working", () => {
    // 171 gwei is where 0.05 MON runs out. Kuru's own quote endpoint returns
    // 180 in its "extreme" tier, so this is a reachable price, not a thought
    // experiment.
    for (const gwei of [130n, 171n, 180n, 300n]) {
      const price = gwei * 1_000_000_000n;
      expect(swapGasReserveWei(price)).toBeGreaterThan(cost(price));
    }
    // ...and pin that the old constant genuinely failed up there.
    expect(OLD_FLAT).toBeLessThan(cost(180n * 1_000_000_000n));
  });

  it("was NOT broken at today's price — this replaced a thin guard, not a bug", () => {
    // Stated as a test so nobody later reads the fix and assumes swaps had been
    // failing. They had not.
    expect(OLD_FLAT).toBeGreaterThan(cost(102_000_000_000n));
  });

  it("scales with the price rather than being a constant", () => {
    const p = 102_000_000_000n;
    expect(swapGasReserveWei(p * 3n)).toBe(swapGasReserveWei(p) * 3n);
    expect(swapGasReserveWei(0n)).toBe(0n);
  });

  it("does not overflow a 64-bit int on a high price", () => {
    // 291,983 x 300 gwei x 2 is past Number.MAX_SAFE_INTEGER. bigint the whole
    // way, which is the same trap that made a bash `printf '0x%x'` silently
    // truncate the value while measuring this.
    expect(swapGasReserveWei(300_000_000_000n)).toBe(175_189_800_000_000_000n);
  });
});
