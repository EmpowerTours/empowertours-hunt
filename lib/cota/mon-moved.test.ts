import { describe, expect, it } from "vitest";
import {
  CONTEST_WINDOW,
  formatMon,
  monMoved,
  type PerpRow,
  type SpotRow,
  weiToMon,
} from "./mon-moved";

// ---------------------------------------------------------------------------
// Pinned to the real ledger, not to invented rows.
//
// Production on 2026-10-02 held exactly four Perpl fills and two Kuru spot
// trades, all for 0xe2ab4658…:
//
//   fills  mkt 10, 214 MON (14 Sep), 131 (15 Sep), 231 (15 Sep), 576 (18 Sep)
//   spot   8 MON sold (21 Sep 07:03), 5 MON sold (21 Sep 04:54)
//
// 1152 MON on the perp, 13 MON on spot. Writing the figures out of the database
// rather than choosing round numbers means a change to the fold shows up here
// as a disagreement with what actually happened.
// ---------------------------------------------------------------------------

const W = "0xe2ab465839e409c80d1ca4bb4508fea7eb808395";
const SEPT = {
  from: new Date("2026-09-01T00:00:00Z"),
  to: new Date("2026-10-01T00:00:00Z"),
};

const sell = (mon: bigint, at: string): SpotRow => ({
  wallet: W,
  ok: true,
  valueWei: (mon * 10n ** 18n).toString(),
  // A sell's output was an ERC-20, so the MON it received is a known nought.
  nativeInWei: "0",
  at: new Date(at),
});

const fill = (sizeUnits: number, at: string): PerpRow => ({
  account: W,
  marketId: 10,
  sizeUnits,
  filledAt: new Date(at),
});

const REAL_SPOT = [
  sell(8n, "2026-09-21T07:03:00Z"),
  sell(5n, "2026-09-21T04:54:00Z"),
];
const REAL_PERP = [
  fill(214, "2026-09-14T00:00:00Z"),
  fill(131, "2026-09-15T00:00:00Z"),
  fill(231, "2026-09-15T00:00:00Z"),
  fill(576, "2026-09-18T00:00:00Z"),
];

describe("monMoved — the real September ledger", () => {
  it("totals the production rows to 1165 MON", () => {
    const [s] = monMoved(REAL_SPOT, REAL_PERP, SEPT);
    expect(s.wallet).toBe(W);
    expect(s.spotSoldWei).toBe(13n * 10n ** 18n);
    expect(s.spotBoughtWei).toBe(0n);
    expect(s.perpUnits).toBe(1152);
    expect(s.totalMon).toBeCloseTo(1165, 9);
    expect(s.unresolvedBuys).toBe(0);
    expect(s.complete).toBe(true);
  });

  it("reports nothing at all for a window the trades fall outside", () => {
    const october = {
      from: new Date("2026-10-01T00:00:00Z"),
      to: new Date("2026-11-01T00:00:00Z"),
    };
    expect(monMoved(REAL_SPOT, REAL_PERP, october)).toEqual([]);
  });
});

describe("monMoved — what it refuses to count", () => {
  it("drops a reverted spot trade, which moved no MON however much gas it burned", () => {
    const reverted: SpotRow = {
      wallet: W,
      ok: false,
      valueWei: (999n * 10n ** 18n).toString(),
      nativeInWei: "0",
      at: new Date("2026-09-20T00:00:00Z"),
    };
    const [s] = monMoved([...REAL_SPOT, reverted], [], SEPT);
    expect(s.spotSoldWei).toBe(13n * 10n ** 18n);
  });

  it("drops a fill on a market that is not MON", () => {
    const btc: PerpRow = { ...fill(5000, "2026-09-16T00:00:00Z"), marketId: 1 };
    const [s] = monMoved([], [...REAL_PERP, btc], SEPT);
    expect(s.perpUnits).toBe(1152);
  });

  it("treats the window's end as exclusive, so no trade lands in two windows", () => {
    const edge = sell(1n, "2026-09-30T00:00:00Z");
    const before = { from: SEPT.from, to: new Date("2026-09-30T00:00:00Z") };
    const after = { from: new Date("2026-09-30T00:00:00Z"), to: SEPT.to };
    expect(monMoved([edge], [], before)).toEqual([]);
    expect(monMoved([edge], [], after)[0].spotSoldWei).toBe(10n ** 18n);
  });

  it("reads a negative size as a magnitude rather than letting it subtract", () => {
    const short: PerpRow = fill(-100, "2026-09-16T00:00:00Z");
    const [s] = monMoved([], [short], SEPT);
    expect(s.perpUnits).toBe(100);
  });
});

describe("monMoved — an undecoded buy is a gap, never a zero", () => {
  const unknown: SpotRow = {
    wallet: W,
    ok: true,
    valueWei: "0",
    nativeInWei: null,
    at: new Date("2026-09-22T00:00:00Z"),
  };

  it("counts the gap and marks the total incomplete instead of adding nought", () => {
    const [s] = monMoved([...REAL_SPOT, unknown], REAL_PERP, SEPT);
    expect(s.unresolvedBuys).toBe(1);
    expect(s.complete).toBe(false);
    // The total is unchanged — it is a FLOOR, and `complete` is what says so.
    // The failure this guards against is the opposite: a silent 0 that reads
    // as a measurement and under-reports whoever has the most gaps.
    expect(s.totalMon).toBeCloseTo(1165, 9);
  });

  it("stays complete when the same buy decodes to a genuine zero", () => {
    const [s] = monMoved(
      [...REAL_SPOT, { ...unknown, nativeInWei: "0" }],
      REAL_PERP,
      SEPT,
    );
    expect(s.unresolvedBuys).toBe(0);
    expect(s.complete).toBe(true);
    expect(s.totalMon).toBeCloseTo(1165, 9);
  });
});

describe("monMoved — precision and keying", () => {
  it("keeps a buy exact in wei even where the display total cannot be", () => {
    // 2938583602703400000000 wei is a real decoded buy (0x2243ee16…b061). It
    // needs 72 bits, so the float total rounds it; the wei figure must not.
    const buy: SpotRow = {
      wallet: W,
      ok: true,
      valueWei: "0",
      nativeInWei: "2938583602703400000000",
      at: new Date("2026-09-23T00:00:00Z"),
    };
    const [s] = monMoved([buy], [], SEPT);
    expect(s.spotBoughtWei).toBe(2_938_583_602_703_400_000_000n);
    expect(s.totalMon).toBeCloseTo(2938.5836027034, 6);
  });

  it("folds the same wallet written in different cases into one row", () => {
    const rows = [
      sell(1n, "2026-09-10T00:00:00Z"),
      {
        ...sell(2n, "2026-09-11T00:00:00Z"),
        wallet: W.toUpperCase().replace("0X", "0x"),
      },
    ];
    const out = monMoved(rows, [], SEPT);
    expect(out).toHaveLength(1);
    expect(out[0].spotSoldWei).toBe(3n * 10n ** 18n);
  });

  it("ranks by MON moved and breaks a tie on the wallet, so the order is stable", () => {
    const a = "0xaaaa000000000000000000000000000000000000";
    const b = "0xbbbb000000000000000000000000000000000000";
    const rows = [
      { ...sell(5n, "2026-09-10T00:00:00Z"), wallet: b },
      { ...sell(5n, "2026-09-10T00:00:00Z"), wallet: a },
      { ...sell(9n, "2026-09-10T00:00:00Z"), wallet: W },
    ];
    expect(monMoved(rows, [], SEPT).map((s) => s.wallet)).toEqual([W, a, b]);
    // Reversing the input must not reorder the output.
    expect(
      monMoved([...rows].reverse(), [], SEPT).map((s) => s.wallet),
    ).toEqual([W, a, b]);
  });
});

describe("formatMon", () => {
  it("shows four places by default", () => {
    expect(formatMon(1165)).toBe("1,165.0000");
    expect(formatMon(2938.5836027034)).toBe("2,938.5836");
  });
});

describe("CONTEST_WINDOW", () => {
  it("spans 5 to 11 October inclusive, in Singapore time", () => {
    // SGT is UTC+8 year round, so these instants are exact. The end is the
    // 12th at midnight rather than the 11th: the 11th is a scoring day and an
    // exclusive bound set a day early would discard all of it.
    expect(CONTEST_WINDOW.from.toISOString()).toBe("2026-10-04T16:00:00.000Z");
    expect(CONTEST_WINDOW.to.toISOString()).toBe("2026-10-11T16:00:00.000Z");
    expect(
      (CONTEST_WINDOW.to.getTime() - CONTEST_WINDOW.from.getTime()) /
        86_400_000,
    ).toBe(7);
  });

  it("counts a trade at the last moment of 11 October SGT and not the first of the 12th", () => {
    const lastMoment = new Date("2026-10-11T15:59:59.999Z"); // 23:59:59.999 SGT 11 Oct
    const justAfter = new Date("2026-10-11T16:00:00.000Z"); //   00:00:00 SGT 12 Oct
    const row = (at: Date): SpotRow => ({
      wallet: "0xabc",
      ok: true,
      valueWei: "1000000000000000000",
      nativeInWei: "0",
      at,
    });
    expect(monMoved([row(lastMoment)], [], CONTEST_WINDOW)).toHaveLength(1);
    expect(monMoved([row(justAfter)], [], CONTEST_WINDOW)).toEqual([]);
  });
});

describe("weiToMon", () => {
  it("converts the ordinary cases", () => {
    expect(weiToMon("0")).toBe(0);
    expect(weiToMon(10n ** 18n)).toBe(1);
    expect(weiToMon("2938583602703400000000")).toBeCloseTo(2938.5836027034, 9);
  });

  it("keeps the whole MON exact past where a naive float loses them", () => {
    // Above ~9,007,199 MON a double can no longer hold every wei integer, so
    // Number(wei) / 1e18 starts shifting the whole part. Dividing as a bigint
    // first keeps it.
    const big = 12_345_678n * 10n ** 18n;
    expect(Math.trunc(weiToMon(big))).toBe(12_345_678);
  });

  it("handles a negative, though nothing here should produce one", () => {
    expect(weiToMon(-(10n ** 18n))).toBe(-1);
  });
});
