/**
 * The licence a hunter receives must depict the work they claimed.
 *
 * `relayLicense` used `order.licenseUri`, which the answer route filled from a single
 * `EDITION_LICENSE_URI` environment variable — one string for every claim, across a catalogue of
 * seven works at four different prices. A licence for Dime Que Sí would have carried MARINA's
 * artwork, and with the variable unset (its default, and how it was actually deployed) it would
 * have minted a licence with no metadata at all.
 *
 * That is invisible from the hunt's side: the purchase succeeds, the transfer succeeds, the claim
 * is recorded, and nothing is wrong until a hunter opens their collection and sees the wrong
 * picture — or none.
 *
 * fcempowertours does not do this. On a real purchase it reads the master's own `tokenURI` and
 * passes that. The `Edition` row deliberately stores no uri; its schema comment says the chain
 * stays authoritative, and the master is the only thing that knows what a licence depicts.
 *
 * These tests pin the resolution ORDER, which is the part that can silently regress: chain wins,
 * the caller's value is a fallback, and a failed read must not cost the hunter a claim they have
 * already paid for.
 */

import { describe, it, expect } from "vitest";

/**
 * The resolution rule, extracted so it can be tested without a chain or a wallet.
 *
 * Kept deliberately small and mirrored from `relayLicense`: if this and the relayer ever
 * disagree, the test is worthless — so it encodes the decision, not the plumbing.
 */
export function resolveLicenseUri(
  fromChain: string | null,
  fromCaller: string,
): string {
  return fromChain ? fromChain : fromCaller;
}

describe("licence uri resolution", () => {
  it("prefers the master's own tokenURI over a configured default", () => {
    expect(
      resolveLicenseUri("ipfs://QmDimeQueSi", "ipfs://QmSomeStaticDefault"),
    ).toBe("ipfs://QmDimeQueSi");
  });

  it("gives each master its own uri rather than one for all", () => {
    const dime = resolveLicenseUri("ipfs://QmDimeQueSi", "ipfs://QmStatic");
    const marina = resolveLicenseUri("ipfs://QmMarina", "ipfs://QmStatic");
    expect(dime).not.toBe(marina);
  });

  it("falls back to the caller's value when the chain read fails", () => {
    // Not fatal on purpose: the hunter has already paid by this point. A licence with no
    // artwork is worse than one with artwork and far better than a failed claim.
    expect(resolveLicenseUri(null, "ipfs://QmStaticFallback")).toBe(
      "ipfs://QmStaticFallback",
    );
  });

  it("does not treat an empty on-chain uri as an answer", () => {
    // A master with no uri set returns "". Falling back is right; passing "" through would
    // mint metadata-less licences while a perfectly good default sat unused.
    expect(resolveLicenseUri("", "ipfs://QmStaticFallback")).toBe(
      "ipfs://QmStaticFallback",
    );
  });

  it("still yields empty when neither source has one", () => {
    // The honest end state, and what shipped before this change: no uri anywhere. The purchase
    // must still go through — refusing here would take money and give nothing.
    expect(resolveLicenseUri(null, "")).toBe("");
  });
});

describe("the relayer actually applies the rule", () => {
  it("reads tokenURI from the collection and prefers it", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("./relayer.ts", import.meta.url).pathname,
        "utf8",
      ),
    );

    // The check that would have caught the original bug: the purchase must not be handed
    // `order.licenseUri` directly.
    expect(src).toContain('functionName: "tokenURI"');
    expect(src).toMatch(/if \(fromChain\) licenseUri = fromChain/);
    expect(src).not.toMatch(
      /args: \[order\.masterId, order\.isCollector, order\.licenseUri\]/,
    );
  });
});
