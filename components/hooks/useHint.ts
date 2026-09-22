"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, fetchHint } from "@/components/hunt/client";
import { haversineMeters } from "@/components/hunt/geo";
import type { GeoFix, HintBand } from "@/components/hunt/types";

/* ---------------------------------------------------------------------------
   Proximity polling, throttled on the client.

   The route allows 12 hints per minute per player and 429s past that. Two
   reasons to stay well under it rather than ride the limit:

   * A 429 blanks the scope, which reads as a broken app.
   * Volume is what defeats quantization. A client that hammers the endpoint is
     doing the same thing an attacker trilaterating a cache would do, and it
     makes the abuse queue's job harder for no player benefit.

   So: never more than one request per MIN_INTERVAL, and only when the player
   has actually moved or the reading has gone stale.
--------------------------------------------------------------------------- */

import { BACKOFF_MS, shouldRequestHint } from "@/components/hooks/hintSchedule";

export type HintStatus = "idle" | "loading" | "ok" | "throttled" | "error";

export interface HintReading {
  band: HintBand | null;
  remaining: number;
  complete: boolean;
  cacheless: boolean;
  status: HintStatus;
  error: string | null;
  /** epoch ms of the reading currently on screen, or null. */
  readAt: number | null;
  refresh: () => void;
}

export function useHint(
  huntId: string,
  fix: GeoFix | null,
  enabled = true,
): HintReading {
  const [band, setBand] = useState<HintBand | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [complete, setComplete] = useState(false);
  const [cacheless, setCacheless] = useState(false);
  const [status, setStatus] = useState<HintStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [readAt, setReadAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  const inFlight = useRef(false);
  const lastRequestAt = useRef(0);
  const lastRequestPos = useRef<{ lat: number; lng: number } | null>(null);
  const blockedUntil = useRef(0);

  const refresh = useCallback(() => {
    // Force the next evaluation to fire regardless of distance moved.
    lastRequestPos.current = null;
    lastRequestAt.current = 0;
    setTick((n) => n + 1);
  }, []);

  // A slow heartbeat drives the decision; the decision itself is what
  // rate-limits, not the heartbeat.
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 2_000);
    return () => window.clearInterval(id);
  }, [enabled]);

  /**
   * The latest fix, read at SEND time rather than depended on.
   *
   * ## This is the check-in bug, still alive in the scope
   *
   * HuntScreen's check-in effect carries the lesson already: "`fix` changes on
   * every GPS update; on a moving phone reporting ±2m that is roughly every
   * second. Each change re-ran the effect, whose cleanup aborted the in-flight
   * check-in — so on exactly the device this is built for, walking, the
   * request never survived long enough to land."
   *
   * Check-in was fixed by moving `fix` to a ref and dropping the abort. This
   * hook was not, and kept BOTH halves: `fix` in the dependency array and
   * `return () => controller.abort()`. So every GPS update killed the hint
   * request in flight, and because `lastRequestAt` was stamped BEFORE the
   * fetch, each aborted attempt still burned the full six-second throttle.
   *
   * Measured on the live hunt 2026-09-22: ZERO completed hint requests across
   * three and a half hours of use, while check-ins on the same screen landed
   * normally. The player stood 2 metres from an unfound cache; a direct probe
   * of the route with their exact coordinates returned `burning, remaining 1`,
   * so the server was right the whole time and the request never arrived.
   */
  const fixRef = useRef(fix);
  useEffect(() => {
    fixRef.current = fix;
  }, [fix]);
  // A BOOLEAN dependency, not the fix itself. It flips once when the first
  // position arrives, so it starts the scope promptly without reintroducing
  // the per-second churn that was the bug.
  const hasFix = fix !== null;

  useEffect(() => {
    const current = fixRef.current;
    if (!enabled || current === null) return;

    const now = Date.now();
    const previous = lastRequestPos.current;
    if (
      !shouldRequestHint({
        enabled,
        hasFix: true,
        inFlight: inFlight.current,
        complete,
        now,
        lastRequestAt: lastRequestAt.current,
        blockedUntil: blockedUntil.current,
        movedMeters:
          previous === null ? Infinity : haversineMeters(previous, current),
      })
    ) {
      return;
    }

    // Deliberately NOT aborted on cleanup, exactly as the check-in POST is
    // not. This is a small request whose whole job is to land; cancelling it
    // because the GPS moved is what broke it. A late reply is ignored instead.
    let ignore = false;
    inFlight.current = true;
    lastRequestPos.current = { lat: current.lat, lng: current.lng };
    setStatus((s) => (s === "ok" ? s : "loading"));

    fetchHint(huntId, current)
      .then((hint) => {
        if (ignore) return;
        setBand(hint.band);
        setRemaining(hint.remaining);
        setComplete(hint.complete);
        setCacheless(hint.cacheless === true);
        setReadAt(Date.now());
        setStatus("ok");
        setError(null);
      })
      .catch((e: unknown) => {
        if (ignore) return;
        if (e instanceof ApiError && e.status === 429) {
          blockedUntil.current = Date.now() + BACKOFF_MS;
          setStatus("throttled");
          setError("Too many readings. The scope will resume shortly.");
          return;
        }
        setStatus("error");
        setError(
          e instanceof ApiError
            ? e.message
            : "Could not reach the hunt server.",
        );
      })
      .finally(() => {
        inFlight.current = false;
        // Stamped when the attempt SETTLES, never when it starts. The old code
        // stamped it up front, so an attempt that was aborted a millisecond
        // later still spent the whole interval — the same mistake the check-in
        // cooldown made ("it was stamped when the request STARTED, so each
        // aborted attempt still burned the full sixty seconds").
        lastRequestAt.current = Date.now();
      });

    return () => {
      ignore = true;
    };
    // `tick` is the heartbeat and `hasFix` starts the scope. `fix` itself is
    // NOT a dependency: it changes about once a second on a walking phone, and
    // depending on it is what aborted every request before it could land.
  }, [enabled, hasFix, huntId, complete, tick]);

  return {
    band,
    remaining,
    complete,
    cacheless,
    status,
    error,
    readAt,
    refresh,
  };
}
