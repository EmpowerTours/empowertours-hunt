// The editions switch has to be SETTABLE, not just readable.
//
// `evaluateEditionEligibility` gates the entire feature on
// `hunt.editionsEnabled`, the column defaults to false, and for the life of
// the feature nothing ever wrote it: not the admin API, not the app, not a
// script. The flag was read in three places and written in none, so the only
// way to run an edition was to UPDATE the row by hand.
//
// These assert the parse, which is what the admin PATCH route spreads
// straight into `prisma.hunt.update`.

import { describe, expect, it } from "vitest";
import { parseHuntInput } from "./hunt-input";

describe("parseHuntInput — editions", () => {
  it("carries editionsEnabled through to the patch", () => {
    const patch = parseHuntInput({ editionsEnabled: true }, "update");
    expect(patch.editionsEnabled).toBe(true);
  });

  it("can turn editions back off", () => {
    // false must survive, not be treated as absent. An `if (value)` here
    // would make the switch one-way.
    const patch = parseHuntInput({ editionsEnabled: false }, "update");
    expect(patch.editionsEnabled).toBe(false);
  });

  it("leaves the flag untouched when it is not in the body", () => {
    // A PATCH that only renames the hunt must not silently open a shop.
    const patch = parseHuntInput({ name: "Cualquier Ciudad" }, "update");
    expect("editionsEnabled" in patch).toBe(false);
  });

  it("does not infer editions from the spawn switch", () => {
    // Opposite directions: a spawn GIVES treasury money, an edition ASKS the
    // hunter for theirs. Enabling payouts must never enable sales.
    const patch = parseHuntInput({ spawnEnabled: true }, "update");
    expect(patch.spawnEnabled).toBe(true);
    expect("editionsEnabled" in patch).toBe(false);
  });

  it("accepts the cadence knobs", () => {
    const patch = parseHuntInput(
      { editionTtlSeconds: 300, editionCooldownSeconds: 600 },
      "update",
    );
    expect(patch.editionTtlSeconds).toBe(300);
    expect(patch.editionCooldownSeconds).toBe(600);
  });

  it("rejects a TTL outside the allowed range", () => {
    expect(() =>
      parseHuntInput({ editionTtlSeconds: 5 }, "update"),
    ).toThrow();
  });
});
