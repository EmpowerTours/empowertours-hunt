// A first-time player must not be shown a sign-in as their first action.
//
// The panel used to be one button, "Continue with your phone", which attempted
// an assertion. Someone with no passkey therefore met the platform's sheet —
// "Scan QR code", "Use security key" — before anything explained what a wallet
// was, and the button that suited them only appeared once that had failed. Two
// onboardings were lost to it in a day at Monad Open, 2026-10-07.
//
// Asserted against the source because the repo has no DOM test environment,
// and the defect is which control exists, not how it renders.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(new URL("./SignInPanel.tsx", import.meta.url), "utf8");

describe("SignInPanel", () => {
  it("offers creating a wallet without needing a failure first", () => {
    // `offerCreate` gated the only create button. If create is reachable only
    // from that branch again, a new player is back to meeting the assertion
    // sheet first.
    const create = SRC.indexOf('run("create")');
    const offerGate = SRC.indexOf("{offerCreate ?");
    expect(create).toBeGreaterThan(-1);
    expect(create).toBeLessThan(offerGate);
  });

  it("still offers sign-in, for a wallet made on another device", () => {
    // Removing it would strand every returning player on a new phone.
    expect(SRC).toContain('run("sign-in")');
    expect(SRC).toContain("I ALREADY HAVE A WALLET");
  });

  it("names the returning path explicitly rather than hiding it", () => {
    // The old protection against minting a second wallet was that create was
    // hidden. The new one is that sign-in says what it is, so it cannot be
    // pressed by accident by someone who has never been here.
    expect(SRC).not.toContain("CONTINUE WITH YOUR PHONE");
  });

  it("does not show the same create control twice", () => {
    expect(SRC.split('run("create")').length - 1).toBe(1);
  });
});
