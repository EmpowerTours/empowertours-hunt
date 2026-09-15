import { describe, expect, it } from "vitest";
import {
  nextRequestId,
  parseOrderUpdate,
  parseFills,
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

describe("parseFills", () => {
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
    // Captured as a bare entry, which is what lives inside the envelope's d[].
    const [fill] = parseFills(frame);
    expect(fill).toEqual({
      orderRq: 42,
      sizeScaled: 113,
      priceScaled: 26411,
      feeBaseUnits: "2657",
      builderFeeBaseUnits: "597",
    });
  });

  it("never reads a fee as a float (the $880-on-a-$0.99-trade bug)", () => {
    const [fill] = parseFills({ oid: 1, s: 116, p: 25832, f: "599", bfa: "599" });
    // Kept a string; scaling is the caller's, with the collateral decimals.
    expect(fill?.feeBaseUnits).toBe("599");
    expect(typeof fill?.feeBaseUnits).toBe("string");
  });

  it("returns nothing when there is no order id to tie a fill back to", () => {
    expect(parseFills({ mt: 99, s: 10 })).toEqual([]);
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

describe("nextRequestId — a counter seeded from lfr, never the clock", () => {
  // Real mt 19 frames from account 5273, captured 2026-09-14 either side of the
  // only order it has ever filled. `lfr` is the venue's last forwarded request
  // id; the Perpl app maps it to lastRequestId (`Math.max(lastRequestId, lfr)`).
  const BEFORE_FIRST_FILL = {
    mt: 19,
    as: [
      { id: 5273, fr: false, fw: true, ft: 0, lfr: 0, b: "10620689", lb: "0" },
    ],
  };
  const AFTER_FIRST_FILL = {
    mt: 19,
    as: [
      { id: 5273, fr: false, fw: true, ft: 0, lfr: 1, b: "8112235", lb: "0" },
    ],
  };
  const acc = (f: unknown) => parseWalletSnapshot(f)[0];

  it("parses lfr off the account frame", () => {
    expect(acc(BEFORE_FIRST_FILL).lastRequestId).toBe(0);
    expect(acc(AFTER_FIRST_FILL).lastRequestId).toBe(1);
  });

  it("is exactly lfr + 1 with no prior send", () => {
    expect(nextRequestId(acc(BEFORE_FIRST_FILL))).toBe(1);
    expect(nextRequestId(acc(AFTER_FIRST_FILL))).toBe(2);
  });

  it("IS NOT A CLOCK — this is what broke account 5273", () => {
    // The old implementation returned max(lfr + 1, Date.now()), which always
    // took the clock. A millisecond value is not in the forwarded id space, so
    // the contract refused every order with OrderDescIdTooLow. The clock is the
    // fw:false legacy path only, per Perpl's own generateRequestId.
    const rq = nextRequestId(acc(AFTER_FIRST_FILL));
    expect(rq).toBeLessThan(1_000_000);
    expect(rq).not.toBe(Date.now());
  });

  it("clears a value this process already sent, when lfr still lags it", () => {
    // The frame is read fresh per order, so lfr can be behind an order sent
    // moments ago; lfr + 1 alone would reuse a spent value.
    expect(nextRequestId(acc(AFTER_FIRST_FILL), 9)).toBe(10);
  });

  it("prefers lfr when the venue is ahead of what we remember", () => {
    expect(nextRequestId({ ...acc(AFTER_FIRST_FILL), lastRequestId: 40 }, 9)).toBe(
      41,
    );
  });

  it("always advances, so two orders never share an rq", () => {
    const a = acc(AFTER_FIRST_FILL);
    let seen = 0;
    for (let i = 0; i < 5; i++) {
      const rq = nextRequestId(a, seen);
      expect(rq).toBeGreaterThan(seen);
      seen = rq;
    }
  });
});

describe("parseOrderUpdate — the frame that says what became of the order", () => {
  const upd = (d: unknown[]) => ({ mt: 24, d });

  it("names the stale-rq refusal the executor spent an evening on", () => {
    // reason 32 is OrderDescIdTooLow: the rq was not greater than the last one
    // the venue forwarded. This frame was arriving the whole time.
    const [u] = parseOrderUpdate(
      upd([{ rq: 1, st: 7, sr: 32, fs: 0, os: 130 }]),
    );
    expect(u.statusName).toBe("Failed");
    expect(u.reasonName).toBe("OrderDescIdTooLow");
    expect(u.filledScaled).toBe(0);
    expect(u.originalScaled).toBe(130);
    expect(u.terminal).toBe(true);
  });

  it("names the forwarding refusal too", () => {
    const [u] = parseOrderUpdate(
      upd([{ rq: 7, st: 7, sr: 34, fs: 0, os: 214 }]),
    );
    expect(u.reasonName).toBe("OrderForwardingNotAllowed");
  });

  it("a fill is terminal; an open order is NOT", () => {
    // Finishing on Open would discard the outcome we are waiting for.
    expect(parseOrderUpdate(upd([{ rq: 1, st: 4 }]))[0].terminal).toBe(true);
    expect(parseOrderUpdate(upd([{ rq: 1, st: 2 }]))[0].terminal).toBe(false);
    expect(parseOrderUpdate(upd([{ rq: 1, st: 3 }]))[0].terminal).toBe(false);
  });

  it("a FILLED order still expects its fill frame — this cost a real fill", () => {
    // Account 5273, 2026-09-15 05:32Z: the venue said Filled/TakerOrderFilled,
    // 131 of 131, on an mt 24. The client finished on it, the mt 25 arrived
    // after the socket closed, `filled` stayed false and the ledger diverged
    // from the venue. Terminal is not the same question as "stop listening".
    const filled = parseOrderUpdate(
      upd([{ rq: 2, st: 4, sr: 43, fs: 131, os: 131 }]),
    )[0];
    expect(filled.terminal).toBe(true);
    expect(filled.expectsFill).toBe(true);
  });

  it("a failed order expects NO fill, so waiting longer is pointless", () => {
    for (const st of [5, 6, 7]) {
      const u = parseOrderUpdate(upd([{ rq: 1, st }]))[0];
      expect(u.terminal).toBe(true);
      expect(u.expectsFill).toBe(false);
    }
  });

  it("the stale-rq failure must not be mistaken for a fill", () => {
    const u = parseOrderUpdate(upd([{ rq: 1, st: 7, sr: 32 }]))[0];
    expect(u.expectsFill).toBe(false);
  });

  it("renders a code this build has never seen instead of dropping it", () => {
    // An unknown name is still the venue's answer; swallowing it puts us back
    // to "accepted, nothing arrived".
    const [u] = parseOrderUpdate(upd([{ rq: 1, st: 99, sr: 98 }]));
    expect(u.statusName).toBe("status 99");
    expect(u.reasonName).toBe("reason 98");
  });

  it("returns every update in the frame, for the caller to match on rq", () => {
    const us = parseOrderUpdate(
      upd([
        { rq: 10, st: 4, sr: 43 },
        { rq: 11, st: 6, sr: 28 },
      ]),
    );
    expect(us.map((u) => u.orderRq)).toEqual([10, 11]);
  });

  it("ignores a frame that is not mt 24, and entries with no rq", () => {
    expect(parseOrderUpdate({ mt: 25, d: [{ rq: 1 }] })).toEqual([]);
    expect(parseOrderUpdate(upd([{ st: 4 }]))).toEqual([]);
  });
});

describe("ORDER_STATUS_REASON — the codes past Mandate's table", () => {
  it("names 48-52, verified from the venue's own reason map", () => {
    const upd = (sr: number) =>
      parseOrderUpdate({ mt: 24, d: [{ rq: 1, st: 7, sr }] })[0].reasonName;
    expect(upd(48)).toBe("PriceNotSpecified");
    expect(upd(49)).toBe("SizeNotSpecified");
    expect(upd(50)).toBe("WrongAccount");
    expect(upd(51)).toBe("WrongNetwork");
    expect(upd(52)).toBe("WrongMarket");
  });

  it("still renders a code past the table rather than dropping it", () => {
    const upd = parseOrderUpdate({ mt: 24, d: [{ rq: 1, st: 7, sr: 53 }] })[0];
    expect(upd.reasonName).toBe("reason 53");
  });
});

describe("parseFills — the envelope that dropped every real fill", () => {
  // THE BUG: mt 25 arrives as {mt:25, d:[entry]} and `oid` is on the ENTRY.
  // Reading it off the envelope returned null every time, so `filled` stayed
  // false and the trade route's recordFill never fired in production. Both
  // ledger fills got in through adoption instead, which is why a real fill
  // surfaced to the hunter as "positions this agent didn't open".
  const ENTRY = { oid: 2, acc: 5273, mkt: 10, t: 1, p: 23159, s: 131, f: "4440" };

  it("unwraps d[] and finds the order id on the entry", () => {
    const fills = parseFills({ mt: 25, d: [ENTRY] });
    expect(fills).toHaveLength(1);
    expect(fills[0].orderRq).toBe(2);
    expect(fills[0].sizeScaled).toBe(131);
    expect(fills[0].priceScaled).toBe(23159);
  });

  it("returns every fill in one frame, for the caller to match on rq", () => {
    const fills = parseFills({
      mt: 25,
      d: [ENTRY, { ...ENTRY, oid: 3, s: 7 }],
    });
    expect(fills.map((f) => f.orderRq)).toEqual([2, 3]);
    expect(fills.map((f) => f.sizeScaled)).toEqual([131, 7]);
  });

  it("does NOT return an envelope-shaped null (the regression)", () => {
    // Before the fix this whole frame parsed to null.
    expect(parseFills({ mt: 25, d: [ENTRY] })[0]).not.toBeUndefined();
  });

  it("drops entries with no order id rather than inventing one", () => {
    expect(parseFills({ mt: 25, d: [{ s: 1, p: 2 }] })).toEqual([]);
  });

  it("is empty for a frame carrying no fills", () => {
    expect(parseFills({ mt: 25, d: [] })).toEqual([]);
    expect(parseFills({ mt: 19, as: [] })).toEqual([]);
  });
});
