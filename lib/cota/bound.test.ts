import { describe, expect, it } from "vitest";
import { boundFromRow, type CotaBoundRow } from "./bound";

// A Prisma Decimal is not a string: it is an object whose toString() carries
// the exact integer. Model that here so the DB shape is actually exercised.
const decimal = (v: string) => ({ toString: () => v });

const DB_ROW: CotaBoundRow = {
  venue: "perpl",
  markets: ["MON"],
  maxNotionalUsdE6: decimal("5000000"),
  maxLeverageX100: decimal("300"),
  maxDailyLossUsdE6: decimal("1000000"),
  maxTradesPerDay: 4,
  notBefore: new Date("2026-09-12T00:00:00.000Z"),
  notAfter: new Date("2026-10-12T00:00:00.000Z"),
  revokedAt: null,
};

// The same leash as the client sees it: JSON, so every field is a string.
const CLIENT_ROW: CotaBoundRow = {
  venue: "perpl",
  markets: ["MON"],
  maxNotionalUsdE6: "5000000",
  maxLeverageX100: "300",
  maxDailyLossUsdE6: "1000000",
  maxTradesPerDay: 4,
  notBefore: "2026-09-12T00:00:00.000Z",
  notAfter: "2026-10-12T00:00:00.000Z",
  revokedAt: null,
};

describe("boundFromRow", () => {
  it("reads the DB shape into the gate's bigints", () => {
    const b = boundFromRow(DB_ROW);
    expect(b.venue).toBe("perpl");
    expect(b.markets).toEqual(["MON"]);
    expect(b.maxNotionalUsdE6).toBe(5_000_000n);
    expect(b.maxLeverageX100).toBe(300n);
    expect(b.maxDailyLossUsdE6).toBe(1_000_000n);
    expect(b.maxTradesPerDay).toBe(4);
    expect(b.notBefore).toBe(1_789_171_200n);
    expect(b.notAfter).toBe(1_791_763_200n);
    expect(b.revokedAt).toBeNull();
  });

  // The whole point of one shared reader: the preview the hunter sees and the
  // bound the server enforces must be the same object, or the UI can promise
  // what the server refuses.
  it("gives the client shape and the DB shape an identical bound", () => {
    expect(boundFromRow(CLIENT_ROW)).toEqual(boundFromRow(DB_ROW));
  });

  it("carries a revocation through from either shape", () => {
    const when = "2026-09-13T10:30:00.000Z";
    expect(
      boundFromRow({ ...DB_ROW, revokedAt: new Date(when) }).revokedAt,
    ).toEqual(new Date(when));
    expect(boundFromRow({ ...CLIENT_ROW, revokedAt: when }).revokedAt).toEqual(
      new Date(when),
    );
  });

  // Seconds, not milliseconds: enforce.ts compares against a unix-second clock,
  // and a 1000x bound would never expire.
  it("truncates sub-second precision toward the past", () => {
    const b = boundFromRow({
      ...CLIENT_ROW,
      notBefore: "2026-09-12T00:00:00.999Z",
    });
    expect(b.notBefore).toBe(1_789_171_200n);
  });

  // Prisma Decimals hold values far past Number.MAX_SAFE_INTEGER; going via
  // Number would round them silently.
  it("keeps a notional too large for a JS number exact", () => {
    const huge = "9007199254740993000000";
    const b = boundFromRow({ ...DB_ROW, maxNotionalUsdE6: decimal(huge) });
    expect(b.maxNotionalUsdE6).toBe(BigInt(huge));
  });
});
