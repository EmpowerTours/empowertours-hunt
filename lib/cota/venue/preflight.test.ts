import { describe, expect, it } from "vitest";
import { parseWalletSnapshot } from "./frames";
import { venuePreflight, type VenueRefusal } from "./preflight";

// Real mt 19 frames from account 5273, captured 2026-09-14. The first is the
// account as it was found the day the executor was first walked end to end —
// funded, unfrozen, and unable to fill anything because fw was false. The
// second is the same account after the hunter sent allowOrderForwarding(true)
// and it took its one and only fill.
const BEFORE_FORWARDING = {
  mt: 19,
  as: [{ id: 5273, fr: false, fw: false, ft: 0, lfr: 0, b: "10620689", lb: "0" }],
};
const AFTER_FIRST_FILL = {
  mt: 19,
  as: [{ id: 5273, fr: false, fw: true, ft: 0, lfr: 1, b: "8112235", lb: "0" }],
};

const acc = (frame: unknown) => parseWalletSnapshot(frame)[0];
const withFields = (frame: unknown, over: Partial<ReturnType<typeof acc>>) => ({
  ...acc(frame),
  ...over,
});

describe("venuePreflight — the frame three bugs were readable from", () => {
  it("clears an account that can actually fill", () => {
    expect(venuePreflight(acc(AFTER_FIRST_FILL))).toBeNull();
  });

  it("names fw:false instead of letting the order be silently dropped", () => {
    // The regression that cost an evening: this frame was in hand the whole
    // time and nothing asked it.
    expect(venuePreflight(acc(BEFORE_FORWARDING))).toBe("forwarding_disabled");
  });

  it("refuses a frozen account", () => {
    expect(
      venuePreflight(withFields(AFTER_FIRST_FILL, { frozen: true })),
    ).toBe("account_frozen");
  });

  it("reports frozen ahead of forwarding — it is the more fundamental fact", () => {
    const both = withFields(BEFORE_FORWARDING, { frozen: true });
    expect(venuePreflight(both)).toBe("account_frozen");
  });

  it("refuses when there is no free collateral to post", () => {
    expect(
      venuePreflight(withFields(AFTER_FIRST_FILL, { available: 0 })),
    ).toBe("no_collateral");
    expect(
      venuePreflight(withFields(AFTER_FIRST_FILL, { available: -1 })),
    ).toBe("no_collateral");
  });

  it("does not refuse merely small collateral — the venue decides sufficiency", () => {
    // A margin formula guessed on this side would turn a fillable order into a
    // false refusal. Only "cannot possibly" is refused here.
    expect(
      venuePreflight(withFields(AFTER_FIRST_FILL, { available: 1 })),
    ).toBeNull();
  });

  it("locked collateral counts against available", () => {
    const fullyLocked = {
      mt: 19,
      as: [
        { id: 5273, fr: false, fw: true, ft: 0, lfr: 1, b: "8112235", lb: "8112235" },
      ],
    };
    expect(acc(fullyLocked).available).toBe(0);
    expect(venuePreflight(acc(fullyLocked))).toBe("no_collateral");
  });

  it("treats a frame the venue never sent as unknown, not as a refusal", () => {
    // placeOrder reports a missing account itself; refusing here would block a
    // hunter on our failed read rather than on a flag the venue set.
    expect(venuePreflight(null)).toBeNull();
  });

  it("every refusal it can return is a distinct named reason", () => {
    const all: VenueRefusal[] = [
      "account_frozen",
      "forwarding_disabled",
      "no_collateral",
    ];
    expect(new Set(all).size).toBe(all.length);
  });
});
