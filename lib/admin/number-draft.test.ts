import { describe, expect, it } from "vitest";
import { commitNumberDraft } from "./number-draft";

describe("commitNumberDraft", () => {
  it("does NOT commit zero for an empty box", () => {
    // The regression. Number("") is 0, which is why clearing the GPS accuracy
    // field wrote 0, re-rendered as "0", and turned a typed 40 into "040".
    expect(commitNumberDraft("")).toBeNull();
    expect(commitNumberDraft("   ")).toBeNull();
  });

  it("commits an ordinary number", () => {
    expect(commitNumberDraft("40")).toBe(40);
    expect(commitNumberDraft("0")).toBe(0);
  });

  it("reads a leading zero as the number, so 040 is 40", () => {
    // Not octal — this is what the user sees after the bug above, and it must
    // still mean forty while they are mid-correction.
    expect(commitNumberDraft("040")).toBe(40);
  });

  it("holds its tongue on the keystrokes that are not yet a number", () => {
    // A type="number" box hands these over on the way to a real value.
    for (const partial of ["-", "e", "+", ".", "-e"]) {
      expect(commitNumberDraft(partial), partial).toBeNull();
    }
  });

  it("refuses NaN and Infinity rather than committing them", () => {
    expect(commitNumberDraft("abc")).toBeNull();
    expect(commitNumberDraft("1e999")).toBeNull();
  });
});
