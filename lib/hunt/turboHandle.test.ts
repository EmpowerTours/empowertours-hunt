import { describe, expect, it } from "vitest";
import {
  TURBO_HANDLE_MAX,
  explainLinkRefusal,
  handleKey,
  mayLinkHandle,
  normaliseHandle,
  TURBO_LINK_REFUSALS,
} from "./turboHandle";

describe("normaliseHandle", () => {
  it("accepts an ordinary handle", () => {
    expect(normaliseHandle("empowertours")).toEqual({
      ok: true,
      handle: "empowertours",
    });
  });

  // People write handles with an @ everywhere else. Refusing it would be a
  // puzzle, not a rule.
  it("strips a leading @ and surrounding space", () => {
    expect(normaliseHandle("  @empowertours ")).toEqual({
      ok: true,
      handle: "empowertours",
    });
  });

  // Lowercased on purpose: Prisma cannot express a `lower()` unique index, so
  // the stored form has to be the comparison form or two wallets can claim one
  // builder identity by changing a capital.
  it("lowercases, because the stored form is the unique key", () => {
    const r = normaliseHandle("EmPowerTours");
    expect(r.ok && r.handle).toBe("empowertours");
  });

  it("refuses empty, over-long and illegal handles", () => {
    expect(normaliseHandle("   ")).toMatchObject({ reason: "empty" });
    expect(normaliseHandle("@")).toMatchObject({ reason: "empty" });
    expect(normaliseHandle("a".repeat(TURBO_HANDLE_MAX + 1))).toMatchObject({
      reason: "too_long",
    });
    for (const bad of ["has space", "-leading", "trailing-", "we/slash", "é"]) {
      expect(normaliseHandle(bad).ok).toBe(false);
    }
  });

  it("accepts exactly the maximum length", () => {
    expect(normaliseHandle("a".repeat(TURBO_HANDLE_MAX)).ok).toBe(true);
  });
});

describe("handleKey", () => {
  // The collision this prevents: two wallets claiming one builder identity by
  // changing a capital.
  it("makes case-different handles one identity", () => {
    expect(handleKey("EmpowerTours")).toBe(handleKey("empowertours"));
  });
});

describe("mayLinkHandle", () => {
  const link = (over: Partial<Parameters<typeof mayLinkHandle>[0]> = {}) =>
    mayLinkHandle({
      raw: "empowertours",
      current: null,
      takenByAnother: false,
      ...over,
    });

  it("links a free handle to an unlinked wallet", () => {
    expect(link()).toEqual({ ok: true, handle: "empowertours" });
  });

  it("refuses a handle another wallet holds", () => {
    expect(link({ takenByAnother: true })).toMatchObject({ reason: "taken" });
  });

  // Set once: credit accrues over weeks and is redeemed against whatever
  // handle the row names at settlement, so a freely mutable handle lets
  // somebody bank credit and redirect it.
  it("refuses to re-point a wallet that already has one", () => {
    expect(link({ current: "someoneelse" })).toMatchObject({
      reason: "already_linked",
    });
  });

  // A double-tap must not read as a failure.
  it("treats re-submitting your own handle as a no-op, case-insensitively", () => {
    expect(link({ current: "empowertours", raw: "EMPOWERTOURS" })).toEqual({
      ok: true,
      handle: "empowertours",
    });
  });

  // Ownership is checked BEFORE availability, so a linked wallet is told the
  // true reason rather than "taken".
  it("reports already_linked even when the new handle is also taken", () => {
    expect(
      link({ current: "mine", raw: "theirs", takenByAnother: true }),
    ).toMatchObject({ reason: "already_linked" });
  });

  it("validates the handle before anything else", () => {
    expect(link({ raw: "", current: "mine" })).toMatchObject({
      reason: "empty",
    });
  });

  // An empty string in the column means unlinked, not linked-to-nothing.
  it("treats an empty stored handle as unlinked", () => {
    expect(link({ current: "" })).toEqual({ ok: true, handle: "empowertours" });
  });
});

describe("explainLinkRefusal", () => {
  it("has copy for every refusal in both languages", () => {
    for (const r of TURBO_LINK_REFUSALS) {
      for (const lang of ["es", "en"] as const) {
        expect(explainLinkRefusal(r, lang).length).toBeGreaterThan(0);
      }
    }
  });
});
