"use client";

import { useCallback, useEffect, useState } from "react";
import type { GeoFix, GeoStatus } from "@/components/hunt/types";
import { useGeoCapability } from "@/components/hooks/useGeoCapability";

/* ---------------------------------------------------------------------------
   One GPS watch for the whole screen.

   Rules this hook exists to enforce:

   * NEVER fabricate a position. There is no default lat/lng, no last-known
     fallback pulled from storage, no "0,0 until we know better". If the device
     has not told us where it is, `fix` is null and the UI says so.
   * NEVER default the accuracy. A device that declines to report accuracy is
     treated as unusable, matching the verifier, which rejects a null accuracy
     rather than taking it as perfect.
   * Permission denied is a terminal state with an honest message, not a
     spinner that never resolves.
--------------------------------------------------------------------------- */

/**
 * How long the device gets to produce a first fix before it reports TIMEOUT.
 *
 * Exported because the UI counts against it. A countdown drawn from a number
 * the screen invented would be a progress bar — it would reach zero while the
 * watch was still running, or sit at 5s for a minute. This is the deadline the
 * browser is actually holding, so the two cannot disagree.
 */
export const GEO_FIX_TIMEOUT_MS = 20_000;

export interface GeoReading {
  status: GeoStatus;
  fix: GeoFix | null;
  message: string | null;
  /**
   * When the CURRENT watch armed (ms epoch), or null when none is running.
   * `since + GEO_FIX_TIMEOUT_MS` is the moment the device must answer by.
   */
  since: number | null;
  /** Re-arm the watch after a denial or a timeout. */
  retry: () => void;
}

const MESSAGES: Record<GeoStatus, string | null> = {
  idle: null,
  unsupported:
    "This browser cannot report a location. A hunt needs GPS — try Safari or Chrome over HTTPS.",
  locating: null,
  ready: null,
  denied:
    "Location permission is off. The hunt cannot verify a claim without it — enable it in your browser's site settings, then retry.",
  unavailable:
    "Your device could not get a fix. Step outside, away from buildings, and retry.",
  timeout:
    "The last fix is stale — your phone has stopped reporting a position. Keep the screen on and retry.",
};

export function useGeolocation(enabled = true): GeoReading {
  const capability = useGeoCapability();
  const [fix, setFix] = useState<GeoFix | null>(null);
  const [attempt, setAttempt] = useState(0);

  // What the CURRENT watch has reported, tagged with the watch it came from.
  // Written only from watchPosition's own callbacks; every other part of
  // `status` is derived during render, which is why nothing here needs an
  // effect to set state.
  //
  // The tag is what makes re-arming forget. `maximumAge: 0` means there is
  // genuinely no current fix until a new one arrives, so a retry reading
  // "locating" again is the honest answer rather than a flicker — and a report
  // from a watch we have already torn down can never be mistaken for a live
  // one.
  const [reported, setReported] = useState<{
    watch: string;
    status: GeoStatus;
  } | null>(null);

  // When this attempt started looking (ms epoch). Stamped at mount and again
  // on every retry — the two moments a player starts waiting — because those
  // are the only places a clock read is allowed to happen: not during render,
  // which must stay pure, and not in the watch effect, which is not an event.
  //
  // It can therefore run a frame or two AHEAD of the watch itself, if the
  // capability probe resolves late. That direction is the safe one: the
  // countdown may reach zero just before the browser's own timeout does, so
  // the player is told "still finding you" a moment early rather than being
  // promised time the device no longer has.
  const [armed, setArmed] = useState<number>(() => Date.now());

  const retry = useCallback(() => {
    setAttempt((n) => n + 1);
    setArmed(Date.now());
  }, []);

  const watch = `${enabled}:${capability}:${attempt}`;
  const current = reported?.watch === watch ? reported.status : null;

  const status: GeoStatus = !enabled
    ? "idle"
    : capability === "unknown"
      ? // Server render, or the instant before hydration. We are about to
        // look; claiming anything more definite would be a guess.
        "locating"
      : capability !== "ok"
        ? "unsupported"
        : (current ?? "locating");

  useEffect(() => {
    if (!enabled || capability !== "ok") return;

    const report = (next: GeoStatus) => setReported({ watch, status: next });

    const id = navigator.geolocation.watchPosition(
      (position) => {
        const c = position.coords;
        // Reject-by-default: a coordinate we cannot trust is no coordinate.
        if (!Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) {
          report("unavailable");
          return;
        }
        if (typeof c.accuracy !== "number" || !Number.isFinite(c.accuracy)) {
          // The verifier refuses a null accuracy outright, so surfacing this as
          // a usable fix would only set the player up to be rejected.
          report("unavailable");
          return;
        }

        setFix({
          lat: c.latitude,
          lng: c.longitude,
          accuracyM: c.accuracy,
          headingDeg:
            typeof c.heading === "number" && Number.isFinite(c.heading)
              ? c.heading
              : null,
          speedMps:
            typeof c.speed === "number" && Number.isFinite(c.speed)
              ? c.speed
              : null,
          at: position.timestamp,
        });
        report("ready");
      },
      (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          setFix(null);
          report("denied");
        } else if (error.code === error.TIMEOUT) {
          // Keep the last fix on screen but stop calling it current.
          report("timeout");
        } else {
          report("unavailable");
        }
      },
      {
        enableHighAccuracy: true,
        timeout: GEO_FIX_TIMEOUT_MS,
        // Never reuse a cached fix: a claim is only as honest as the moment it
        // was measured.
        maximumAge: 0,
      },
    );

    return () => navigator.geolocation.clearWatch(id);
  }, [enabled, capability, watch]);

  return {
    status,
    fix,
    message: MESSAGES[status],
    // Null once the watch has answered or was never armed: a countdown only
    // makes sense while something is still owed to the player.
    since: status === "locating" ? armed : null,
    retry,
  };
}
