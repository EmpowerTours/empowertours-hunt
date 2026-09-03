"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { headingFromEvent, type OrientationLike } from "@/lib/hunt/heading";

// ---------------------------------------------------------------------------
// The device compass.
//
// ## No environment sniffing
//
// An earlier version kept "is this iOS", "does the API exist" and "have we
// been granted" as state, which meant deciding them in an effect body and
// setting state synchronously — cascading renders, and a hydration mismatch
// waiting to happen because none of it is knowable on the server.
//
// It is also unnecessary. The hook simply listens, and `request()` is always
// safe to call: on a platform with no permission gate it is a no-op, and on
// iOS it opens the prompt. The only question the UI ever needs answered is
// "do we have a heading right now", which is one piece of state set from a
// subscription callback.
//
// ## A relative heading never counts
//
// See lib/hunt/heading.ts. Rotating a scope by a relative alpha produces an
// instrument that looks authoritative and points somewhere arbitrary, which is
// worse than admitting the scope is north-up.
// ---------------------------------------------------------------------------

export interface HeadingState {
  /** Degrees clockwise from north, or null when we do not honestly have one. */
  heading: number | null;
  /** True once the player has explicitly refused the permission prompt. */
  denied: boolean;
  /**
   * Ask for the compass. Safe on every platform, and safe to call twice.
   * Must be called from a user gesture — iOS refuses otherwise.
   */
  request: () => void;
}

interface OrientationCtor {
  requestPermission?: () => Promise<"granted" | "denied" | "default">;
}

/**
 * @param enabled false parks the hook without listening — a scope that is not
 *   on screen has no business holding a sensor open.
 */
export function useHeading(enabled = true): HeadingState {
  const [heading, setHeading] = useState<number | null>(null);
  const [denied, setDenied] = useState(false);
  const [granted, setGranted] = useState(0);

  // Throttle to ~10Hz. The magnetometer fires far faster and every event would
  // otherwise be a React render, on the screen somebody is holding while
  // walking down a street.
  const lastRef = useRef(0);

  const request = useCallback(() => {
    const ctor = (
      window as unknown as { DeviceOrientationEvent?: OrientationCtor }
    ).DeviceOrientationEvent;

    if (typeof ctor?.requestPermission !== "function") {
      // No gate on this platform. Bump the counter anyway so the listener
      // effect re-runs — on some Androids the absolute event only starts
      // arriving after a user interaction.
      setGranted((n) => n + 1);
      return;
    }

    ctor
      .requestPermission()
      .then((result) => {
        if (result === "granted") {
          setDenied(false);
          setGranted((n) => n + 1);
        } else {
          setDenied(true);
        }
      })
      .catch(() => {
        setDenied(true);
      });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined") return;
    if (!("DeviceOrientationEvent" in window)) return;

    const onEvent = (raw: Event) => {
      const now = Date.now();
      if (now - lastRef.current < 100) return;
      lastRef.current = now;

      const next = headingFromEvent(raw as unknown as OrientationLike);
      // Do NOT clear a heading we already had. Magnetometers emit unusable
      // samples routinely, and reacting to one would snap the scope back to
      // north-up and then round again a moment later.
      if (next !== null) setHeading(next);
    };

    // `deviceorientationabsolute` is the one that is actually absolute on
    // Android. Plain `deviceorientation` is listened to as well because that
    // is where iOS delivers webkitCompassHeading — and headingFromEvent
    // refuses anything relative regardless of which event carried it.
    window.addEventListener("deviceorientationabsolute", onEvent, true);
    window.addEventListener("deviceorientation", onEvent, true);
    return () => {
      window.removeEventListener("deviceorientationabsolute", onEvent, true);
      window.removeEventListener("deviceorientation", onEvent, true);
    };
  }, [enabled, granted]);

  return { heading, denied, request };
}
