import { describe, it, expect } from "vitest";

// No mocks: both functions under test are pure, which is the whole point of
// keeping them out of the route. If this file ever needs a database, the
// module has drifted from its contract.
import {
  decideStepCompletion,
  countersAfterCompletion,
  type StepCompletionContext,
} from "@/lib/career/progress";

const TOURS = 10n ** 18n;

/** A clean, acceptable completion. Each test perturbs exactly one field. */
function ctx(over: Partial<StepCompletionContext> = {}): StepCompletionContext {
  return {
    trackActive: true,
    stepActive: true,
    playerActive: true,
    playerSuspended: false,
    enrollmentStatus: "ACTIVE",
    stepVerifier: "GPS_FIND",
    evidenceVerifier: "GPS_FIND",
    hasEvidence: true,
    alreadyCompleted: false,
    sequential: false,
    stepOrdinal: 1,
    nextRequiredOrdinal: 1,
    toursAwardWei: 5n * TOURS,
    ...over,
  };
}

describe("decideStepCompletion", () => {
  it("accepts a clean completion and snapshots the award", () => {
    expect(decideStepCompletion(ctx())).toEqual({
      accepted: true,
      toursAwardSnapshotWei: 5n * TOURS,
    });
  });

  it("accepts a step worth nothing", () => {
    // A step can be worth progress and no TOURS. That is a configuration, not
    // an error, and it must not be confused with a missing award.
    expect(decideStepCompletion(ctx({ toursAwardWei: 0n }))).toEqual({
      accepted: true,
      toursAwardSnapshotWei: 0n,
    });
  });

  describe("moderation is checked before anything else", () => {
    it("rejects a suspended player", () => {
      expect(decideStepCompletion(ctx({ playerSuspended: true }))).toEqual({
        accepted: false,
        reason: "player_suspended",
      });
    });

    it("rejects an inactive player", () => {
      expect(decideStepCompletion(ctx({ playerActive: false }))).toEqual({
        accepted: false,
        reason: "player_inactive",
      });
    });

    it("reports suspension even when the step is also wrong", () => {
      // Ordering matters: a banned wallet should not learn from the reason
      // code whether its evidence would otherwise have worked.
      const decision = decideStepCompletion(
        ctx({ playerSuspended: true, evidenceVerifier: "GITHUB_PUSH" }),
      );
      expect(decision).toEqual({
        accepted: false,
        reason: "player_suspended",
      });
    });
  });

  it("rejects an inactive track", () => {
    expect(decideStepCompletion(ctx({ trackActive: false }))).toEqual({
      accepted: false,
      reason: "track_inactive",
    });
  });

  it("rejects an inactive step", () => {
    expect(decideStepCompletion(ctx({ stepActive: false }))).toEqual({
      accepted: false,
      reason: "step_inactive",
    });
  });

  it.each(["COMPLETED", "WITHDRAWN", "SUSPENDED"] as const)(
    "rejects an enrollment in %s",
    (status) => {
      expect(decideStepCompletion(ctx({ enrollmentStatus: status }))).toEqual({
        accepted: false,
        reason: "enrollment_not_active",
      });
    },
  );

  it("rejects a step already completed", () => {
    // Belt to the unique key's braces. The constraint is the enforcement; this
    // exists so the common case returns a legible reason instead of a 500 from
    // a violated index.
    expect(decideStepCompletion(ctx({ alreadyCompleted: true }))).toEqual({
      accepted: false,
      reason: "already_completed",
    });
  });

  describe("evidence must match the verifier the step declares", () => {
    it("refuses a GitHub push against an attendance step", () => {
      expect(
        decideStepCompletion(
          ctx({ stepVerifier: "GPS_FIND", evidenceVerifier: "GITHUB_PUSH" }),
        ),
      ).toEqual({ accepted: false, reason: "verifier_mismatch" });
    });

    it("refuses a GPS find against a coursework step", () => {
      expect(
        decideStepCompletion(
          ctx({ stepVerifier: "GITHUB_PUSH", evidenceVerifier: "GPS_FIND" }),
        ),
      ).toEqual({ accepted: false, reason: "verifier_mismatch" });
    });

    it("refuses an admin attestation against a machine-verified step", () => {
      // Without this, ADMIN_ATTEST becomes a skeleton key for every step in
      // the system and the other two verifiers stop meaning anything.
      expect(
        decideStepCompletion(
          ctx({ stepVerifier: "GPS_FIND", evidenceVerifier: "ADMIN_ATTEST" }),
        ),
      ).toEqual({ accepted: false, reason: "verifier_mismatch" });
    });

    it("refuses a submission against an attendance step", () => {
      // Uploading a photo must not stand in for turning up, and turning up
      // must not stand in for doing the work. They are different claims.
      expect(
        decideStepCompletion(
          ctx({ stepVerifier: "GPS_FIND", evidenceVerifier: "SUBMISSION" }),
        ),
      ).toEqual({ accepted: false, reason: "verifier_mismatch" });
    });

    it("accepts a submission when the step asks for one", () => {
      expect(
        decideStepCompletion(
          ctx({ stepVerifier: "SUBMISSION", evidenceVerifier: "SUBMISSION" }),
        ),
      ).toEqual({ accepted: true, toursAwardSnapshotWei: 5n * TOURS });
    });

    it("rejects a submission step with no artifact attached", () => {
      // A SUBMISSION completion whose CID is missing is unauditable forever:
      // the entire value of this verifier is that the evidence outlives it.
      expect(
        decideStepCompletion(
          ctx({
            stepVerifier: "SUBMISSION",
            evidenceVerifier: "SUBMISSION",
            hasEvidence: false,
          }),
        ),
      ).toEqual({ accepted: false, reason: "missing_evidence" });
    });

    it("allows an admin attestation when the step asks for one", () => {
      expect(
        decideStepCompletion(
          ctx({
            stepVerifier: "ADMIN_ATTEST",
            evidenceVerifier: "ADMIN_ATTEST",
          }),
        ),
      ).toEqual({ accepted: true, toursAwardSnapshotWei: 5n * TOURS });
    });

    it("rejects a matching verifier that produced nothing to point at", () => {
      expect(decideStepCompletion(ctx({ hasEvidence: false }))).toEqual({
        accepted: false,
        reason: "missing_evidence",
      });
    });

    it("reports a mismatch ahead of missing evidence", () => {
      expect(
        decideStepCompletion(
          ctx({ evidenceVerifier: "GITHUB_PUSH", hasEvidence: false }),
        ),
      ).toEqual({ accepted: false, reason: "verifier_mismatch" });
    });
  });

  describe("sequential tracks", () => {
    it("accepts the step the learner owes", () => {
      expect(
        decideStepCompletion(
          ctx({ sequential: true, stepOrdinal: 4, nextRequiredOrdinal: 4 }),
        ),
      ).toEqual({ accepted: true, toursAwardSnapshotWei: 5n * TOURS });
    });

    it("refuses skipping ahead", () => {
      // The bug this pins: with nothing completed yet, week 52 must not be
      // reachable just because no earlier completion exists to compare against.
      expect(
        decideStepCompletion(
          ctx({ sequential: true, stepOrdinal: 52, nextRequiredOrdinal: 1 }),
        ),
      ).toEqual({ accepted: false, reason: "out_of_order" });
    });

    it("refuses doubling back", () => {
      expect(
        decideStepCompletion(
          ctx({ sequential: true, stepOrdinal: 2, nextRequiredOrdinal: 7 }),
        ),
      ).toEqual({ accepted: false, reason: "out_of_order" });
    });

    it("refuses when the route could not name the next step", () => {
      // Reject by default: "no next step" and "any step" look identical here.
      expect(
        decideStepCompletion(
          ctx({ sequential: true, stepOrdinal: 1, nextRequiredOrdinal: null }),
        ),
      ).toEqual({ accepted: false, reason: "out_of_order" });
    });

    it("refuses a NaN ordinal rather than comparing through it", () => {
      expect(() =>
        decideStepCompletion(
          ctx({ sequential: true, stepOrdinal: NaN, nextRequiredOrdinal: 1 }),
        ),
      ).toThrow(RangeError);
    });

    it("ignores ordering entirely on a non-sequential track", () => {
      expect(
        decideStepCompletion(
          ctx({ sequential: false, stepOrdinal: 52, nextRequiredOrdinal: 1 }),
        ),
      ).toEqual({ accepted: true, toursAwardSnapshotWei: 5n * TOURS });
    });

    it("tolerates non-contiguous ordinals", () => {
      // A curriculum numbered 10/20/30 must gate on the ordinal that exists,
      // not on highest + 1.
      expect(
        decideStepCompletion(
          ctx({ sequential: true, stepOrdinal: 20, nextRequiredOrdinal: 20 }),
        ),
      ).toEqual({ accepted: true, toursAwardSnapshotWei: 5n * TOURS });
    });
  });

  describe("impossible states throw rather than reject", () => {
    it("throws on a negative award", () => {
      expect(() => decideStepCompletion(ctx({ toursAwardWei: -1n }))).toThrow(
        RangeError,
      );
    });

    it("throws when the award is not a bigint", () => {
      expect(() =>
        decideStepCompletion(ctx({ toursAwardWei: 5 as unknown as bigint })),
      ).toThrow(TypeError);
    });

    it("throws on a fractional ordinal", () => {
      expect(() => decideStepCompletion(ctx({ stepOrdinal: 1.5 }))).toThrow(
        RangeError,
      );
    });
  });
});

describe("countersAfterCompletion", () => {
  const base = {
    completedStepCount: 3,
    earnedToursWei: 15n * TOURS,
    highestCompletedOrdinal: 3,
  };

  it("advances the count, the balance and the high-water mark", () => {
    expect(
      countersAfterCompletion(base, {
        stepOrdinal: 4,
        toursAwardSnapshotWei: 5n * TOURS,
      }),
    ).toEqual({
      completedStepCount: 4,
      earnedToursWei: 20n * TOURS,
      highestCompletedOrdinal: 4,
    });
  });

  it("sets the high-water mark on the first completion", () => {
    expect(
      countersAfterCompletion(
        {
          completedStepCount: 0,
          earnedToursWei: 0n,
          highestCompletedOrdinal: null,
        },
        { stepOrdinal: 7, toursAwardSnapshotWei: 0n },
      ),
    ).toEqual({
      completedStepCount: 1,
      earnedToursWei: 0n,
      highestCompletedOrdinal: 7,
    });
  });

  it("never walks the high-water mark backwards", () => {
    // A non-sequential track can complete a lower ordinal after a higher one.
    // Assigning rather than taking the max would re-open a passed step.
    expect(
      countersAfterCompletion(base, {
        stepOrdinal: 1,
        toursAwardSnapshotWei: 2n * TOURS,
      }),
    ).toEqual({
      completedStepCount: 4,
      earnedToursWei: 17n * TOURS,
      highestCompletedOrdinal: 3,
    });
  });

  it("keeps full precision on a large balance", () => {
    // The reason everything here is bigint: 1e18 does not survive a double.
    const huge = 10n ** 30n + 1n;
    expect(
      countersAfterCompletion(
        {
          completedStepCount: 1,
          earnedToursWei: huge,
          highestCompletedOrdinal: 1,
        },
        { stepOrdinal: 2, toursAwardSnapshotWei: 1n },
      ).earnedToursWei,
    ).toBe(huge + 1n);
  });

  it.each([
    ["a negative award", { stepOrdinal: 2, toursAwardSnapshotWei: -1n }],
  ])("throws on %s", (_label, completed) => {
    expect(() => countersAfterCompletion(base, completed)).toThrow(RangeError);
  });

  it("throws on a negative starting balance", () => {
    expect(() =>
      countersAfterCompletion(
        { ...base, earnedToursWei: -1n },
        { stepOrdinal: 4, toursAwardSnapshotWei: 0n },
      ),
    ).toThrow(RangeError);
  });

  it("throws when a count arrives as a float", () => {
    expect(() =>
      countersAfterCompletion(
        { ...base, completedStepCount: 3.5 },
        { stepOrdinal: 4, toursAwardSnapshotWei: 0n },
      ),
    ).toThrow(RangeError);
  });
});
