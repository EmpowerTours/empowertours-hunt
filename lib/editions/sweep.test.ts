import { describe, expect, it } from "vitest";
import { decideSweep, licenseIdFromLogs } from "./sweep";

const RELAYER = "0x1BbB5b25aD829613E91e63FBfd727e21D71A0168";
const HUNTER = "0xe2ab465839e409c80d1ca4bb4508fea7eb808395";
const STRANGER = "0x000000000000000000000000000000000000dEaD";
const SALES = "0xf824D444AAf251EB2197836FFb218d48927F8cB1";

// The sweeper sends somebody else's money. Every branch that could send twice,
// or send what we do not own, is decided in decideSweep — so that is what gets
// tested, not the plumbing around it.

describe("deciding what to do with a stranded licence", () => {
  const base = { licenseId: 42n, relayer: RELAYER, recipient: HUNTER };

  it("transfers when the relayer still holds it", () => {
    expect(decideSweep({ ...base, owner: RELAYER })).toEqual({
      act: "transfer",
      licenseId: 42n,
    });
  });

  it("does nothing when the hunter already has it", () => {
    // An earlier sweep, a manual send, or a transfer whose receipt we failed
    // to read. Re-sending is impossible anyway — the relayer no longer owns it.
    expect(decideSweep({ ...base, owner: HUNTER })).toEqual({
      act: "already_delivered",
      licenseId: 42n,
    });
  });

  it("refuses to act when a third party holds it", () => {
    const out = decideSweep({ ...base, owner: STRANGER });
    expect(out.act).toBe("not_held");
  });

  it("NEVER transfers on an unknown owner", () => {
    // Acting on a failed ownerOf read is exactly how a sweeper double-sends.
    const out = decideSweep({ ...base, owner: null });
    expect(out.act).toBe("not_held");
    expect(out.act).not.toBe("transfer");
  });

  it("asks for the licence id rather than guessing one", () => {
    expect(decideSweep({ ...base, licenseId: null, owner: RELAYER })).toEqual({
      act: "needs_license_id",
    });
  });

  it("compares addresses case-insensitively", () => {
    // Checksummed from the chain, lowercase from the database. A case-sensitive
    // compare would call every held licence "not held" and sweep nothing.
    expect(decideSweep({ ...base, owner: RELAYER.toLowerCase() }).act).toBe(
      "transfer",
    );
    expect(
      decideSweep({
        ...base,
        recipient: HUNTER.toUpperCase().replace("0X", "0x"),
        owner: HUNTER,
      }).act,
    ).toBe("already_delivered");
  });
});

describe("recovering the licence id from the purchase receipt", () => {
  const TOPIC0 =
    "0xcd9b3a3c6d5b7c3e7dcf67d99c3778fcb5be4250ef5f2e547d87e99b7695394f";
  const pad = (a: string) =>
    `0x${"0".repeat(24)}${a.slice(2)}` as `0x${string}`;
  const num = (n: number) =>
    `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;

  const log = (buyer: string, licenseId: number, address = SALES) => ({
    address,
    topics: [TOPIC0, num(licenseId), num(7), pad(buyer)] as `0x${string}`[],
  });

  it("finds the id the relayer bought", () => {
    expect(licenseIdFromLogs([log(RELAYER, 99)], SALES, RELAYER)).toBe(99n);
  });

  it("ignores a purchase by somebody else in the same block", () => {
    expect(licenseIdFromLogs([log(STRANGER, 5)], SALES, RELAYER)).toBeNull();
  });

  it("ignores an identical event from another contract", () => {
    expect(
      licenseIdFromLogs([log(RELAYER, 5, STRANGER)], SALES, RELAYER),
    ).toBeNull();
  });

  it("returns null rather than throwing on a malformed log", () => {
    expect(
      licenseIdFromLogs(
        [{ address: SALES, topics: [TOPIC0] as `0x${string}`[] }],
        SALES,
        RELAYER,
      ),
    ).toBeNull();
    expect(licenseIdFromLogs([], SALES, RELAYER)).toBeNull();
  });
});
