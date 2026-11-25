import { describe, expect, it } from "vitest";
import {
  REAL_MONEY_CLOSED,
  realMoneyAllowed,
  realMoneyAllowlist,
  realMoneyClosedBody,
} from "./real-money";

const FOUNDER = "0x52908400098527886e0f7030069857d2e4169ee7"; // EIP-55 vector
const FOUNDER_CHECKSUM = "0x52908400098527886E0F7030069857D2E4169EE7";
const OTHER = "0xde709f2102306220921060314715629080e2fb77";

describe("realMoneyAllowlist", () => {
  it("is empty when unset or blank (fail closed)", () => {
    expect(realMoneyAllowlist(undefined).size).toBe(0);
    expect(realMoneyAllowlist("").size).toBe(0);
    expect(realMoneyAllowlist(" , ,").size).toBe(0);
  });

  it("checksums entries and ignores ones that are not addresses", () => {
    const list = realMoneyAllowlist(` ${FOUNDER} ,not-an-address,0x123,`);
    expect([...list]).toEqual([FOUNDER_CHECKSUM]);
  });
});

describe("realMoneyAllowed", () => {
  it("allows an allowlisted wallet in any letter case", () => {
    expect(realMoneyAllowed(FOUNDER, FOUNDER)).toBe(true);
    expect(realMoneyAllowed(FOUNDER_CHECKSUM, FOUNDER)).toBe(true);
    expect(realMoneyAllowed(FOUNDER, FOUNDER_CHECKSUM)).toBe(true);
    expect(
      realMoneyAllowed(FOUNDER.toUpperCase().replace("0X", "0x"), FOUNDER),
    ).toBe(true);
  });

  it("refuses a wallet that is not on the list", () => {
    expect(realMoneyAllowed(OTHER, FOUNDER)).toBe(false);
  });

  it("refuses everyone when the list is empty or unset", () => {
    expect(realMoneyAllowed(FOUNDER, "")).toBe(false);
    expect(realMoneyAllowed(FOUNDER, undefined)).toBe(false);
  });

  it("refuses a missing or malformed wallet", () => {
    expect(realMoneyAllowed(null, FOUNDER)).toBe(false);
    expect(realMoneyAllowed(undefined, FOUNDER)).toBe(false);
    expect(realMoneyAllowed("", FOUNDER)).toBe(false);
    expect(realMoneyAllowed("0x1234", FOUNDER)).toBe(false);
  });

  it("reads COTA_REAL_MONEY_ALLOWLIST by default", () => {
    const prev = process.env.COTA_REAL_MONEY_ALLOWLIST;
    try {
      process.env.COTA_REAL_MONEY_ALLOWLIST = `${OTHER},${FOUNDER}`;
      expect(realMoneyAllowed(FOUNDER)).toBe(true);
      delete process.env.COTA_REAL_MONEY_ALLOWLIST;
      expect(realMoneyAllowed(FOUNDER)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.COTA_REAL_MONEY_ALLOWLIST;
      else process.env.COTA_REAL_MONEY_ALLOWLIST = prev;
    }
  });
});

describe("realMoneyClosedBody", () => {
  it("carries the notice text and a machine reason", () => {
    expect(realMoneyClosedBody()).toEqual({
      error: "Real-money trading is closed for now.",
      reason: REAL_MONEY_CLOSED,
    });
  });
});
