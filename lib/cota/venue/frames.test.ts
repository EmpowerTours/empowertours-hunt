import { describe, expect, it } from "vitest";
import {
  parseFill,
  parseOrderStatus,
  parsePositions,
  parseWalletSnapshot,
  signinCanonicalBytes,
} from "./frames";

// Golden traces: shapes taken from real Perpl frames (via Mandate's venue_mock,
// documented as corrected against a live fill) and real captured values from
// account 5103's live trades this session.

describe("sign-in canonical bytes", () => {
  it("joins chain_id, context, timestamp, nonce with newlines", () => {
    const bytes = signinCanonicalBytes(143, 1788901925000, "abc123");
    expect(new TextDecoder().decode(bytes)).toBe(
      "143\ntrading-ws-signin\n1788901925000\nabc123",
    );
  });
});

describe("parseWalletSnapshot", () => {
  it("reads accounts from `as` and computes free collateral", () => {
    // Real: account 5103, 11.521424 AUSD free, fee tier 0 (from a live read).
    const frame = {
      mt: 19,
      sn: 1,
      addr: "0x" + "11".repeat(20),
      n: 0,
      fl: 0,
      as: [
        {
          mt: 21,
          in: 1,
          id: 5103,
          fr: false,
          fw: true,
          ft: 0,
          lfr: 0,
          b: 11_521_424,
          lb: 0,
        },
      ],
    };
    const [acc] = parseWalletSnapshot(frame);
    expect(acc.accountId).toBe(5103);
    expect(acc.available).toBe(11_521_424); // 11.52 AUSD in 6dp base units
    expect(acc.feeTier).toBe(0);
    expect(acc.frozen).toBe(false);
    expect(acc.forwardingAllowed).toBe(true);
  });

  // The refusal that matters most, triggered on purpose against the real frame
  // that caused it. Account 5273 was two hours old, funded and unfrozen, and
  // every order it sent was accepted by the gateway and dropped by the chain.
  // `fw:false` is the whole explanation, and it is one boolean off this frame.
  it("reads fw:false off a fresh account that cannot be traded", () => {
    // Captured 2026-09-13 from account 5273 (hunt hunter), verbatim.
    const frame = {
      mt: 19,
      as: [
        {
          id: 5273,
          fr: false,
          fw: false,
          ft: 0,
          b: "10620689",
          lb: "0",
        },
      ],
    };
    const [acc] = parseWalletSnapshot(frame);
    expect(acc.accountId).toBe(5273);
    expect(acc.forwardingAllowed).toBe(false);
    // Everything else is healthy — which is exactly why the failure was silent.
    expect(acc.frozen).toBe(false);
    expect(acc.available).toBe(10_620_689);
  });

  // Only an EXPLICIT false blocks. A venue that stops sending `fw` must not
  // silently refuse every hunter a trade it would have filled — see the note on
  // AccountSnapshot.forwardingAllowed, and Mandate's matching default.
  it("treats a missing fw as allowed rather than blocking the account", () => {
    const [acc] = parseWalletSnapshot({
      mt: 19,
      as: [{ id: 1, fr: false, ft: 0, b: "1", lb: "0" }],
    });
    expect(acc.forwardingAllowed).toBe(true);
  });

  it("returns nothing for a non-snapshot frame", () => {
    expect(parseWalletSnapshot({ mt: 3 })).toEqual([]);
  });
});

describe("parseOrderStatus", () => {
  it("reads an accepted ack (code 0) and echoes the client seq", () => {
    const s = parseOrderStatus({
      mt: 3,
      sid: 100,
      sn: 0,
      cid: 7,
      status: { code: 0, error: "" },
    });
    expect(s).toEqual({ clientSeq: 7, code: 0, error: "", accepted: true });
  });

  it("reads a rejection (403 no trade scope) as not accepted", () => {
    const s = parseOrderStatus({
      mt: 3,
      cid: 7,
      status: { code: 403, error: "api key lacks trade scope" },
    });
    expect(s?.accepted).toBe(false);
    expect(s?.code).toBe(403);
  });
});

describe("parseFill", () => {
  it("parses the real $3 fill, keeping fee/builder-fee as base-unit strings", () => {
    // The frame recorded for the live $3 MON long: 113 units @ 26411 (6dp),
    // fee 2657 base units, builder fee 597 base units — as STRINGS, not floats.
    const frame = {
      at: { b: 1, t: 1788843932000, tx: 0, txid: "0".repeat(64), l: 0 },
      oid: 42,
      acc: 5103,
      mkt: 10,
      t: 1,
      p: 26411,
      s: 113,
      f: "2657",
      bfa: "597",
    };
    const fill = parseFill(frame);
    expect(fill).toEqual({
      orderRq: 42,
      sizeScaled: 113,
      priceScaled: 26411,
      feeBaseUnits: "2657",
      builderFeeBaseUnits: "597",
    });
  });

  it("never reads a fee as a float (the $880-on-a-$0.99-trade bug)", () => {
    const fill = parseFill({ oid: 1, s: 116, p: 25832, f: "599", bfa: "599" });
    // Kept a string; scaling is the caller's, with the collateral decimals.
    expect(fill?.feeBaseUnits).toBe("599");
    expect(typeof fill?.feeBaseUnits).toBe("string");
  });

  it("returns null when there is no order id to tie the fill back to", () => {
    expect(parseFill({ mt: 99, s: 10 })).toBeNull();
  });
});

describe("parsePositions — the entry price the frame was said not to have", () => {
  // Captured verbatim from account 5273 on 2026-09-14: the first position this
  // executor ever opened, read live off the trading socket. The codebase held
  // that Perpl's position frames carry no entry price or PnL — sourced from
  // Mandate's KNOWN_POSITION_KEYS, which lists only the keys Mandate parsed.
  // This frame is the counter-example, so it is pinned here rather than
  // described.
  const LIVE_5273 = {
    mt: 26,
    sid: 50,
    sn: 104844377,
    at: { b: 104844377, t: 1789418262000 },
    d: [
      {
        at: {},
        mkt: 10,
        acc: 5273,
        pid: 6870209921025,
        rq: 0,
        oid: 0,
        st: 1,
        sr: 0,
        sd: 1,
        c: "2504014",
        ep: 23308,
        s: 214,
        fee: "4440",
        cfee: "0",
        efs: 64466,
        lv: 200,
        cpnl: "0",
        dpnl: "0",
        fnd: "0",
        pay: "0",
        xfs: 0,
        ots: { b: 104831084, t: 1789414247000, tx: 4 },
      },
    ],
  };

  it("reads the entry price and fee off the live frame", () => {
    const [p] = parsePositions(LIVE_5273);
    expect(p.marketId).toBe(10);
    expect(p.side).toBe(1);
    expect(p.sizeScaled).toBe(214);
    expect(p.leverageX100).toBe(200);
    expect(p.entryPriceScaled).toBe(23308);
    expect(p.feeScaled).toBe(4440);
  });

  it("agrees with the venue's own traded volume", () => {
    // The account stats frame alongside this one reported tv = "4987912".
    // size × entry must reproduce it exactly, or `ep` is not the entry price.
    const [p] = parsePositions(LIVE_5273);
    expect(p.sizeScaled * (p.entryPriceScaled ?? 0)).toBe(4_987_912);
  });

  it("reads a frame without ep as null, never as zero", () => {
    // Null is not zero: a zero entry would price a position at free and make any
    // loss computed from it nonsense. Absence has to stay absence.
    const [p] = parsePositions({
      mt: 26,
      d: [{ pid: 1, mkt: 10, st: 1, sd: 1, s: 100, lv: 100 }],
    });
    expect(p.entryPriceScaled).toBeNull();
    expect(p.feeScaled).toBeNull();
  });
});
