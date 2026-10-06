// Spawns must not be switchable on with nothing to pay out.
//
// The Monad open hunt, 2026-10-06: spawns enabled, budget funded, and
// spawnMinMon / spawnMaxMon both left at their schema default of 0. The save
// was accepted — the only other money check here is min > max, and 0 > 0 is
// false. lib/hunt/spawn.ts then refused every scan with
// `spawn_bounds_misconfigured`, which components/hunt/copy.ts classes as
// TERMINAL, so the client stopped polling. The operator saw a radar that never
// populated, and no error anywhere.

import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { validateHuntConsistency } from "./hunt-input";

const base = {
  spawnMinRadiusM: 30,
  spawnMaxRadiusM: 60,
  startsAt: null,
  endsAt: null,
  spawnEnabled: true,
  budgetMonWei: new Prisma.Decimal("1000000000000000000"),
  autoApproveMaxWei: new Prisma.Decimal(0),
};

describe("validateHuntConsistency — spawn payout bounds", () => {
  it("refuses a zero range while spawns are on", () => {
    expect(() =>
      validateHuntConsistency({
        ...base,
        spawnMinWei: new Prisma.Decimal(0),
        spawnMaxWei: new Prisma.Decimal(0),
      }),
    ).toThrow(/spawnMinMon or spawnMaxMon is 0/);
  });

  it("refuses a zero MINIMUM even when the maximum is set", () => {
    // This is the case only the new rule catches. A zero maximum with a real
    // minimum already trips "spawnMinMon cannot exceed spawnMaxMon" above, but
    // min 0 / max 0.0015 passes every older check and still produces a hunt
    // that refuses every scan.
    expect(() =>
      validateHuntConsistency({
        ...base,
        spawnMinWei: new Prisma.Decimal(0),
        spawnMaxWei: new Prisma.Decimal("1500000000000000"),
      }),
    ).toThrow(/spawnMinMon or spawnMaxMon is 0/);
  });

  it("still refuses a zero maximum, by whichever rule gets there first", () => {
    expect(() =>
      validateHuntConsistency({
        ...base,
        spawnMinWei: new Prisma.Decimal("500000000000000"),
        spawnMaxWei: new Prisma.Decimal(0),
      }),
    ).toThrow();
  });

  it("allows a zero range while spawns are OFF", () => {
    // A hunt mid-setup has not picked its amounts yet. Only enabling payouts
    // with nothing to pay is the error.
    expect(() =>
      validateHuntConsistency({
        ...base,
        spawnEnabled: false,
        spawnMinWei: new Prisma.Decimal(0),
        spawnMaxWei: new Prisma.Decimal(0),
      }),
    ).not.toThrow();
  });

  it("allows a real range", () => {
    expect(() =>
      validateHuntConsistency({
        ...base,
        spawnMinWei: new Prisma.Decimal("500000000000000"),
        spawnMaxWei: new Prisma.Decimal("1500000000000000"),
      }),
    ).not.toThrow();
  });
});
