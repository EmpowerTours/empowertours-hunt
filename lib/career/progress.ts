// Career step completion — the pure half.
//
// Whether a learner may complete a step is decided HERE, from facts the route
// supplies: no database, no network, no clock. Same discipline as
// lib/hunt/validator.ts and lib/hunt/credit.ts, and for the same payoff — a
// disputed completion is answered by replaying stored rows through this
// function rather than by anyone reconstructing what the route was thinking.
//
// REJECT BY DEFAULT. Every branch that is not an explicit accept returns a
// reason code. Comparisons are written so an undefined or NaN falls into the
// reject branch instead of through it.
//
// THE RULE THIS FILE EXISTS TO ENFORCE:
//
//   Evidence must match the verifier the step declares. A GPS find must not
//   complete a coursework step, and a GitHub push must not complete an
//   attendance step. Without this check the two verifiers collapse into one
//   ("something happened"), and the whole claim that a completed track means
//   anything collapses with them.
//
// WHAT IS *NOT* HERE, DELIBERATELY:
//
//   * The exactly-once guarantee. `alreadyCompleted` below is the same
//     predicate the route evaluates, but it is documentation and test surface,
//     NOT the enforcement. Enforcement is the unique key
//     `StepCompletion.@@unique([enrollmentId, stepId])` failing the INSERT.
//     A boolean checked in application code is a read-then-write: two
//     concurrent submissions both observe `false`, both pass, and the step
//     completes twice. Keep the two in sync — the constraint is authoritative.
//
//   * Any TOURS transfer. This module decides what a completion is WORTH and
//     nothing more. Nothing in this repo pays TOURS out yet.

/** Mirrors `VerifierKind` in prisma/schema.prisma. */
export type VerifierKind =
  "GPS_FIND" | "GITHUB_PUSH" | "SUBMISSION" | "ADMIN_ATTEST";

/** Mirrors `EnrollmentStatus` in prisma/schema.prisma. */
export type EnrollmentStatus =
  "ACTIVE" | "COMPLETED" | "WITHDRAWN" | "SUSPENDED";

/**
 * Why a completion was refused. Stable string literals: these are persisted
 * and read by a human during a dispute, so renaming one rewrites history.
 */
export type StepRejectReason =
  | "player_suspended"
  | "player_inactive"
  | "track_inactive"
  | "step_inactive"
  | "enrollment_not_active"
  | "already_completed"
  | "verifier_mismatch"
  | "missing_evidence"
  | "out_of_order";

export interface StepCompletionContext {
  trackActive: boolean;
  stepActive: boolean;

  playerActive: boolean;
  playerSuspended: boolean;

  enrollmentStatus: EnrollmentStatus;

  /** What the step demands as proof. */
  stepVerifier: VerifierKind;
  /** What the route actually managed to prove. */
  evidenceVerifier: VerifierKind;
  /**
   * Whether the route holds a concrete evidence pointer — a Find id, a commit
   * SHA, or a named attestor. A verifier that matched but produced nothing to
   * point at is not proof, and a completion row with neither pointer nor
   * attestor is unauditable.
   */
  hasEvidence: boolean;

  /** Same predicate as the unique key; see the note above on why both exist. */
  alreadyCompleted: boolean;

  /** Track requires lower ordinals first. */
  sequential: boolean;
  stepOrdinal: number;
  /**
   * Sequential tracks only: the lowest ordinal among the track's ACTIVE steps
   * that this enrollment has not completed. The route computes it; deriving it
   * here from a high-water mark would assume ordinals are contiguous, and a
   * curriculum that numbers itself 10/20/30 — or that deactivates a step —
   * would then gate on an ordinal that does not exist.
   *
   * Null means the route could not determine one. That REJECTS rather than
   * waving the step through, because "no next step" and "any step" are
   * indistinguishable here and only one of them is safe.
   */
  nextRequiredOrdinal: number | null;

  /** TOURS the step is configured to be worth, in wei. */
  toursAwardWei: bigint;
}

export type StepCompletionDecision =
  | { accepted: true; toursAwardSnapshotWei: bigint }
  | { accepted: false; reason: StepRejectReason };

function reject(reason: StepRejectReason): StepCompletionDecision {
  return { accepted: false, reason };
}

/**
 * Decide whether one step completion may be written.
 *
 * Throws — rather than rejecting — on a state the database constraints make
 * impossible. Reaching this function with a negative award or a non-integer
 * ordinal means something upstream is already wrong, and quietly refusing
 * would launder that bug into a rejection reason a human would then try to
 * explain to a learner.
 */
export function decideStepCompletion(
  ctx: StepCompletionContext,
): StepCompletionDecision {
  if (typeof ctx.toursAwardWei !== "bigint") {
    throw new TypeError("toursAwardWei must be a bigint");
  }
  if (ctx.toursAwardWei < 0n) {
    throw new RangeError("negative TOURS award");
  }
  if (!Number.isInteger(ctx.stepOrdinal)) {
    throw new RangeError("stepOrdinal must be an integer");
  }
  if (
    ctx.nextRequiredOrdinal !== null &&
    !Number.isInteger(ctx.nextRequiredOrdinal)
  ) {
    throw new RangeError("nextRequiredOrdinal must be an integer or null");
  }

  // Moderation first, before anything that could leak the shape of a track to
  // a banned wallet — the same ordering the claim path uses.
  if (ctx.playerSuspended) return reject("player_suspended");
  if (!(ctx.playerActive === true)) return reject("player_inactive");

  if (!(ctx.trackActive === true)) return reject("track_inactive");
  if (!(ctx.stepActive === true)) return reject("step_inactive");

  if (ctx.enrollmentStatus !== "ACTIVE") return reject("enrollment_not_active");

  if (ctx.alreadyCompleted) return reject("already_completed");

  // The load-bearing check. Kept above the evidence test so a mismatched
  // verifier reports as a mismatch rather than as missing evidence — the two
  // mean very different things to whoever reads the log.
  if (ctx.evidenceVerifier !== ctx.stepVerifier) {
    return reject("verifier_mismatch");
  }
  if (!(ctx.hasEvidence === true)) return reject("missing_evidence");

  // Sequential tracks: this must be the next step the learner owes, which the
  // route identified as the lowest ACTIVE ordinal they have not completed.
  // Written as an equality against that single value rather than as `>=` or a
  // gap check, so skipping ahead and doubling back are refused by the same
  // branch and a NaN ordinal cannot compare its way through.
  if (ctx.sequential) {
    if (ctx.nextRequiredOrdinal === null) return reject("out_of_order");
    if (!(ctx.stepOrdinal === ctx.nextRequiredOrdinal)) {
      return reject("out_of_order");
    }
  }

  return { accepted: true, toursAwardSnapshotWei: ctx.toursAwardWei };
}

/**
 * The enrollment counters after an accepted completion.
 *
 * Separate from the decision so the numbers can be tested without restating
 * the whole context, and so the route writes counters it did not compute
 * inline. Returns the values to SET, not deltas — the caller applies them in
 * the same transaction as the StepCompletion insert, so a partial write cannot
 * leave the counters describing a completion that does not exist.
 */
export interface EnrollmentCounters {
  completedStepCount: number;
  earnedToursWei: bigint;
  highestCompletedOrdinal: number;
}

export function countersAfterCompletion(
  current: {
    completedStepCount: number;
    earnedToursWei: bigint;
    highestCompletedOrdinal: number | null;
  },
  completed: { stepOrdinal: number; toursAwardSnapshotWei: bigint },
): EnrollmentCounters {
  if (!Number.isInteger(current.completedStepCount)) {
    throw new RangeError("completedStepCount must be an integer");
  }
  if (current.completedStepCount < 0) {
    throw new RangeError("negative completedStepCount");
  }
  if (typeof current.earnedToursWei !== "bigint") {
    throw new TypeError("earnedToursWei must be a bigint");
  }
  if (current.earnedToursWei < 0n) {
    throw new RangeError("negative earnedToursWei");
  }
  if (typeof completed.toursAwardSnapshotWei !== "bigint") {
    throw new TypeError("toursAwardSnapshotWei must be a bigint");
  }
  if (completed.toursAwardSnapshotWei < 0n) {
    throw new RangeError("negative TOURS award");
  }

  // A non-sequential track can complete a lower ordinal after a higher one, so
  // this is a max, not an assignment. Assigning would walk the high-water mark
  // backwards and re-open a step the learner already passed.
  const highest =
    current.highestCompletedOrdinal === null
      ? completed.stepOrdinal
      : Math.max(current.highestCompletedOrdinal, completed.stepOrdinal);

  return {
    completedStepCount: current.completedStepCount + 1,
    earnedToursWei: current.earnedToursWei + completed.toursAwardSnapshotWei,
    highestCompletedOrdinal: highest,
  };
}
