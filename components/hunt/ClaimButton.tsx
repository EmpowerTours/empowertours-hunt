"use client";

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

export function claimGate({
  fix,
  maxAccuracyM,
  phase,
  cooldownSecondsLeft,
  complete,
  huntActive,
}: {
  fix: GeoFix | null;
  maxAccuracyM: number;
  phase: ClaimPhase;
  cooldownSecondsLeft: number;
  complete: boolean;
  huntActive: boolean;
}): ClaimGate {
  if (phase === "signing") {
    return { ready: false, label: "SIGNING…", hint: "Confirm with Face ID." };
  }
  if (phase === "submitting") {
    return { ready: false, label: "CHECKING…", hint: null };
  }
  if (!huntActive) {
    return { ready: false, label: "HUNT CLOSED", hint: null };
  }
  if (complete) {
    return {
      ready: false,
      label: "ALL FOUND",
      hint: "Nothing left to claim here.",
    };
  }
  if (fix === null) {
    return {
      ready: false,
      label: "NO FIX",
      hint: "Waiting for your phone to report a position.",
    };
  }
  if (fixQuality(fix, maxAccuracyM) === "too-coarse") {
    return {
      ready: false,
      label: `NEED ±${maxAccuracyM} M`,
      hint: `Currently ±${Math.round(fix.accuracyM)} m — the server refuses a claim on this fix.`,
    };
  }
  if (cooldownSecondsLeft > 0) {
    return {
      ready: false,
      label: `WAIT ${cooldownSecondsLeft}s`,
      hint: "Finds are spaced out on purpose.",
    };
  }
  return { ready: true, label: "CLAIM THIS SPOT", hint: null };
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
