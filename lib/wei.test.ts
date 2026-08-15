import { describe, it, expect } from "vitest";
import {
  toWei,
  toSignedWei,
  fromWei,
  formatMon,
  parseMonInput,
  WeiError,
} from "@/lib/wei";

// A stand-in for Prisma.Decimal that reproduces the two behaviours that matter:
// `toString()` switches to exponent notation at 1e21, `toFixed()` never does.
// Verified against @prisma/client 6.19.3: new Prisma.Decimal("1e21").toString()
// === "1e+21", which BigInt() throws on.
class FakeDecimal {
  constructor(
    private readonly plain: string,
    private readonly exponential?: string,
  ) {}
  toFixed(): string {
    return this.plain;
  }
  toString(): string {
    return this.exponential ?? this.plain;
  }
}

describe("toWei", () => {
  it("accepts a plain integer string", () => {
    expect(toWei("1000000000000000")).toBe(1_000_000_000_000_000n);
    expect(toWei("0")).toBe(0n);
  });

  it("accepts a safe integer number", () => {
    expect(toWei(42)).toBe(42n);
  });

  it("reads a Decimal via toFixed, not toString", () => {
    // The regression: a 1000 MON payout stringifies as "1e+21" and BigInt()
    // throws on it. Reading toFixed() keeps the value plain.
    const d = new FakeDecimal("1000000000000000000000", "1e+21");
    expect(toWei(d as never)).toBe(10n ** 21n);
  });

  it("never rounds a fractional Decimal into an integer", () => {
    // toFixed(0) would return "1"; toFixed() returns "0.5" and is rejected.
    expect(() => toWei(new FakeDecimal("0.5") as never)).toThrow(WeiError);
  });

  it.each([
    ["", "empty string — BigInt('') is 0n, which pays nothing silently"],
    [" 5 ", "padded — BigInt accepts it, hiding whatever else was pasted"],
    ["1e18", "exponent — a person means 1 MON, BigInt throws"],
    ["0x10", "hex — BigInt returns 16n in an all-decimal field"],
    ["0.5", "fractional"],
    ["-1", "negative"],
    ["+5", "signed"],
    ["1_000", "separators"],
    ["abc", "not a number"],
    ["007", "leading zeros are ambiguous input"],
  ])("rejects %j (%s)", (bad) => {
    expect(() => toWei(bad)).toThrow(WeiError);
  });

  it("rejects a float, an infinity and a NaN", () => {
    expect(() => toWei(0.5)).toThrow(WeiError);
    expect(() => toWei(Number.POSITIVE_INFINITY)).toThrow(WeiError);
    expect(() => toWei(Number.NaN)).toThrow(WeiError);
    expect(() => toWei(-1)).toThrow(WeiError);
    expect(() => toWei(2 ** 53)).toThrow(WeiError);
  });

  it("rejects a value wider than Decimal(78, 0)", () => {
    expect(() => toWei("1".repeat(79))).toThrow(WeiError);
    expect(toWei("1".repeat(78))).toBe(BigInt("1".repeat(78)));
  });
});

describe("toSignedWei", () => {
  it("permits a negative ledger correction", () => {
    expect(toSignedWei("-500")).toBe(-500n);
    expect(toSignedWei(-7)).toBe(-7n);
  });

  it("still rejects the ambiguous forms", () => {
    for (const bad of ["", " -5 ", "-1e18", "-0x10", "-0.5", "--1"]) {
      expect(() => toSignedWei(bad)).toThrow(WeiError);
    }
  });
});

describe("fromWei", () => {
  it("round-trips through toWei", () => {
    const v = 123_456_789_012_345_678n;
    expect(toWei(fromWei(v))).toBe(v);
  });

  it("emits plain notation past 1e21 where Number would not", () => {
    expect(fromWei(10n ** 21n)).toBe("1000000000000000000000");
  });

  it("rejects a value wider than the column instead of letting Postgres do it mid-transaction", () => {
    expect(() => fromWei(10n ** 78n)).toThrow(WeiError);
    expect(() => fromWei(10n ** 77n)).not.toThrow();
  });
});

describe("formatMon", () => {
  it("formats the spawn-sized amounts this game actually pays", () => {
    expect(formatMon(1_000_000_000_000_000n)).toBe("0.001");
    expect(formatMon(10n ** 18n)).toBe("1");
    expect(formatMon(0n)).toBe("0");
    expect(formatMon(1n)).toBe("0.000000000000000001");
  });

  it("truncates rather than rounds, so display never overstates the send", () => {
    // 0.0019 MON shown at 3dp is 0.001, not 0.002.
    expect(formatMon(1_900_000_000_000_000n, 3)).toBe("0.001");
  });

  it("handles a negative (ledger) value", () => {
    expect(formatMon(-1_000_000_000_000_000n)).toBe("-0.001");
  });

  it("rejects a nonsense precision", () => {
    expect(() => formatMon(1n, 19)).toThrow(WeiError);
    expect(() => formatMon(1n, -1)).toThrow(WeiError);
    expect(() => formatMon(1n, 1.5)).toThrow(WeiError);
  });
});

describe("parseMonInput", () => {
  it("parses human MON amounts to wei", () => {
    expect(parseMonInput("0.001")).toBe(1_000_000_000_000_000n);
    expect(parseMonInput("1")).toBe(10n ** 18n);
    expect(parseMonInput("0")).toBe(0n);
    expect(parseMonInput("12.5")).toBe(12_500_000_000_000_000_000n);
    expect(parseMonInput("0.000000000000000001")).toBe(1n);
  });

  it.each([
    ["1e18", "exponent: means 1 MON to a person, 1e18 wei to nobody"],
    ["0x10", "hex prefix"],
    ["", "empty admin field"],
    [" 5 ", "whitespace padding"],
    ["5 ", "trailing space"],
    [" 5", "leading space"],
    ["-1", "negative"],
    ["-0.001", "negative fraction"],
    ["+1", "explicit sign"],
    ["0.0000000000000000001", "19 decimal places — sub-wei precision"],
    [".5", "bare leading dot"],
    ["5.", "bare trailing dot"],
    ["1,000", "thousands separator"],
    ["1 000", "spaced separator"],
    ["Infinity", "not a number"],
    ["NaN", "not a number"],
    ["00.1", "leading zeros"],
    ["1.2.3", "two dots"],
  ])("rejects %j (%s)", (bad) => {
    expect(() => parseMonInput(bad)).toThrow(WeiError);
  });

  it("rejects an amount wider than the column", () => {
    expect(() => parseMonInput("1".repeat(61))).toThrow(WeiError);
  });
});
