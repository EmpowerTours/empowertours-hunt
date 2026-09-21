// A response that offers a card must carry everything needed to pay for it.
//
// ## The bug this encodes
//
// The placement route has two branches that both answer `offered: true`: one
// that CREATES a card, and one that returns the card already live. Only the
// first returned `payTo`.
//
// That is invisible in isolation and fatal in sequence. HuntScreen re-runs the
// fetch on every scan tick and stores `payTo: body.payTo ?? null`, and a card
// lives 300 seconds. So the tick that created the card returned payTo and the
// very next tick overwrote it with null. EditionCard then bails at
// `if (!payTo)` before it ever signs: the hunter taps BUY, gets "something went
// wrong", and nothing reaches the server — no payment, no claim row, no trace
// beyond a card that ends up `dismissedAt`.
//
// Reproduced on mainnet 2026-09-21: master 8 (MARINA) offered at 35 MON to a
// wallet holding 95 MON, unbuyable. The only reason it was not worse is that
// the client refuses before moving money rather than after.
//
// ## Why it lives in lib/ and not next to the route
//
// vitest.config.ts includes only `lib/**` and `components/**`. A test written
// beside the route never runs at all — it reports nothing, passes nothing, and
// looks like coverage. Found immediately after writing this one there.
//
// ## Why this is a source check and not a request test
//
// Both branches are reachable only with a signed-in player, a live hunt, a
// readable catalogue and a funded relayer. Standing all that up to assert one
// field would test the harness more than the route. The invariant is
// structural — "every offered:true carries payTo" — so the source is the right
// thing to read, and it fails the moment somebody adds a third branch.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "app",
    "api",
    "hunt",
    "[huntId]",
    "edition",
    "route.ts",
  ),
  "utf8",
);

/** Comments describe intent; only code decides. */
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("edition placement — every offer can be paid", () => {
  it("returns payTo from EVERY branch that offers a card", () => {
    const offers = [...code.matchAll(/offered:\s*true/g)];
    // Two today: the live card and the freshly drawn one. If a third appears,
    // this count changes and whoever added it has to look at the assertion
    // below rather than inherit it silently.
    expect(offers.length).toBeGreaterThanOrEqual(2);

    for (const m of offers) {
      // The response object this sits in, read to its closing brace.
      const start = m.index ?? 0;
      const after = code.slice(start, start + 1200);
      expect(
        /payTo\s*:/.test(after),
        `an "offered: true" response at index ${start} does not send payTo — ` +
          `EditionCard bails at if (!payTo) and the hunter cannot buy`,
      ).toBe(true);
    }
  });

  it("derives payTo from the relayer config, never from a literal", () => {
    // A hardcoded address would keep paying a wallet we have rotated away
    // from, and the hunter's money would land somewhere nothing watches.
    const literals = code.match(/payTo\s*:\s*"0x[0-9a-fA-F]{40}"/g);
    expect(literals).toBeNull();
    expect(/payTo\s*:\s*relayerConfig\(\)/.test(code)).toBe(true);
  });
});
