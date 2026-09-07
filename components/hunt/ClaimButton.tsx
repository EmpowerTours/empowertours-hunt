"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/primitives";
import { fixQuality } from "./FixReadout";
import type { GeoFix } from "./types";

/* ---------------------------------------------------------------------------
   The claim button knows why it is disabled, and says so on its own face.

   Everything here mirrors a check the verifier will run anyway. The point is
   not to replace the server check — it cannot, and must not try — but to stop
   the player walking to a spot and tapping a button that was never going to be
   accepted. The server remains the only thing that decides.
--------------------------------------------------------------------------- */

export type ClaimPhase = "idle" | "signing" | "submitting";

export interface ClaimGate {
  ready: boolean;
  label: string;
  hint: string | null;
}

export function useClaimGate({
  fix,
  maxAccuracyM,
  phase,
  cooldownSecondsLeft,
  complete,
  cacheless = false,
  huntActive,
}: {
  fix: GeoFix | null;
  maxAccuracyM: number;
  phase: ClaimPhase;
  cooldownSecondsLeft: number;
  complete: boolean;
  /** This hunt holds no caches at all — see PublicHint.cacheless. */
  cacheless?: boolean;
  huntActive: boolean;
}): ClaimGate {
  // Every label and hint here reaches the player, so they are translated. The
  // branching itself mirrors the verifier's checks and stays as-is. A hook
  // rather than a plain function so it can read the message catalogue.
  const t = useTranslations("claimButton");

  if (phase === "signing") {
    return {
      ready: false,
      label: t("signing"),
      hint: t("signingHint"),
    };
  }
  if (phase === "submitting") {
    return { ready: false, label: t("checking"), hint: null };
  }
  if (!huntActive) {
    return { ready: false, label: t("huntClosed"), hint: null };
  }
  // Before `complete`, because a hunt with nothing in it is not a hunt
  // somebody finished. Telling a player "nothing left to claim" on a
  // spawn-only hunt reads as an ending when it is the normal state.
  if (cacheless) {
    return {
      ready: false,
      label: t("spawnsOnly"),
      hint: t("spawnsOnlyHint"),
    };
  }
  if (complete) {
    return {
      ready: false,
      label: t("allFound"),
      hint: t("allFoundHint"),
    };
  }
  if (fix === null) {
    return {
      ready: false,
      label: t("noFix"),
      hint: t("noFixHint"),
    };
  }
  if (fixQuality(fix, maxAccuracyM) === "too-coarse") {
    return {
      ready: false,
      label: t("needAccuracy", { meters: maxAccuracyM }),
      hint: t("needAccuracyHint", { current: Math.round(fix.accuracyM) }),
    };
  }
  if (cooldownSecondsLeft > 0) {
    return {
      ready: false,
      label: t("wait", { seconds: cooldownSecondsLeft }),
      hint: t("waitHint"),
    };
  }
  return { ready: true, label: t("claim"), hint: null };
}

export function ClaimButton({
  gate,
  onClaim,
}: {
  gate: ClaimGate;
  onClaim: () => void;
}) {
  return (
    <div className="space-y-2">
      <Button
        type="button"
        onClick={onClaim}
        disabled={!gate.ready}
        aria-describedby={gate.hint ? "claim-hint" : undefined}
      >
        {gate.label}
      </Button>
      {gate.hint ? (
        <p id="claim-hint" className="text-ink-dim px-1 text-center text-sm">
          {gate.hint}
        </p>
      ) : null}
    </div>
  );
}
