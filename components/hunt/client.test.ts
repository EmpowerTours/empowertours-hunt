import { describe, expect, it, afterEach, vi } from "vitest";
import { fetchProgress } from "./client";

/* ---------------------------------------------------------------------------
   `fetchProgress` is a WHITELIST, and that is the whole hazard.

   It rebuilds the response field by field rather than passing it through, so a
   key the server adds and the UI renders can still be missing in between and
   nothing fails: no type error, no console warning, no empty row. Just a
   section that never appears.

   That is exactly what happened to `editions`. The server has resolved and
   returned them, and ProgressPanel has rendered them, since "wallet: show the
   record you own, not its token id" — but this function never copied the key,
   so `progress.editions` was always undefined and the section's
   `editions && editions.length > 0` was never once true. Three SENT
   EditionClaim rows in the live database, and a wallet showing none of them.

   So these tests assert the PASSING THROUGH, not the rendering.
--------------------------------------------------------------------------- */

function respondWith(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  );
}

const EDITION = {
  id: "clm1",
  masterId: "8",
  tier: "STANDARD",
  status: "SENT",
  paidWei: "35000000000000000000",
  licenseId: "41",
  txHash: "0xabc",
  at: "2026-09-21T19:44:31.449Z",
  name: "MARINA",
  imageUrl: "https://example.test/marina.png",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchProgress editions", () => {
  it("carries a purchased work through to the wallet", async () => {
    respondWith({ editions: [EDITION] });
    const progress = await fetchProgress();
    expect(progress.editions).toHaveLength(1);
    expect(progress.editions?.[0]).toMatchObject({
      id: "clm1",
      masterId: "8",
      name: "MARINA",
      paidWei: "35000000000000000000",
      txHash: "0xabc",
    });
  });

  // The regression, stated as the thing that was false: the array must exist
  // even when it is empty, so "nothing yet" and "we dropped the key" are not
  // the same value.
  it("returns an array, not undefined, when the player owns nothing", async () => {
    respondWith({ payouts: [] });
    const progress = await fetchProgress();
    expect(Array.isArray(progress.editions)).toBe(true);
    expect(progress.editions).toHaveLength(0);
  });

  // A giveaway sends "0". It must survive: paidWei is required precisely so
  // that a MISSING value is dropped rather than rendered as free.
  it("keeps a zero price rather than treating it as absent", async () => {
    respondWith({ editions: [{ ...EDITION, paidWei: "0" }] });
    const progress = await fetchProgress();
    expect(progress.editions?.[0]?.paidWei).toBe("0");
  });

  // PENDING has no receipt yet. The row still has to show, or a hunter who has
  // just paid sees a gap where the thing they bought should be.
  it("keeps a PENDING row whose receipt has not landed", async () => {
    respondWith({
      editions: [{ ...EDITION, status: "PENDING", txHash: null }],
    });
    const progress = await fetchProgress();
    expect(progress.editions?.[0]).toMatchObject({
      status: "PENDING",
      txHash: null,
    });
  });

  // The venue may not have answered. Null artwork is renderable — the panel
  // falls back to "#id" — so it must not drop the row.
  it("keeps a row the catalogue could not name", async () => {
    respondWith({ editions: [{ ...EDITION, name: null, imageUrl: null }] });
    const progress = await fetchProgress();
    expect(progress.editions?.[0]).toMatchObject({
      masterId: "8",
      name: null,
      imageUrl: null,
    });
  });

  // Reject by default: a row missing something the UI cannot render without is
  // dropped, never defaulted into a plausible-looking lie.
  it("drops a malformed row without losing the good ones", async () => {
    respondWith({
      editions: [
        { ...EDITION, paidWei: undefined },
        { ...EDITION, id: null },
        "not an object",
        EDITION,
      ],
    });
    const progress = await fetchProgress();
    expect(progress.editions).toHaveLength(1);
    expect(progress.editions?.[0]?.id).toBe("clm1");
  });

  it("survives a body with no editions key at all", async () => {
    respondWith({});
    await expect(fetchProgress()).resolves.toMatchObject({ editions: [] });
  });
});
