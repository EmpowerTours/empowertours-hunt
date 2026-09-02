import { describe, expect, it } from "vitest";
import { HUNT_PRF_SALT_LABEL } from "./derive";

// The guard lives inside passkey.ts, which imports mera — a browser library.
// Importing it here would pull that in for no benefit, so the invariant it
// depends on is pinned instead: the parent-rpId branch is only safe while the
// salt label is hunt's own, and this is the statement that fails if it moves.
describe("the salt label the parent-rpId guard checks against", () => {
  it("is still hunt's own", () => {
    expect(HUNT_PRF_SALT_LABEL).toBe("empowertours-hunt/passkey/v1");
  });

  it("is not Regalo's, which is the collision the guard exists for", () => {
    expect(HUNT_PRF_SALT_LABEL).not.toContain("regalo");
  });
});
