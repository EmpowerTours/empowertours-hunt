import { describe, expect, it } from "vitest";
import {
  parseFill,
  parseOrderStatus,
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
