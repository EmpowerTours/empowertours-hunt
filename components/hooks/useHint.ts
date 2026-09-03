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

const MIN_INTERVAL_MS = 6_000;
const STALE_AFTER_MS = 12_000;
const MOVED_METERS = 15;
const BACKOFF_MS = 20_000;

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

  useEffect(() => {
    if (!enabled || fix === null || complete) return;

    const now = Date.now();
    if (inFlight.current) return;
    if (now < blockedUntil.current) return;
    if (now - lastRequestAt.current < MIN_INTERVAL_MS) return;

    const previous = lastRequestPos.current;
    const moved = previous === null ? Infinity : haversineMeters(previous, fix);
    const stale = now - lastRequestAt.current > STALE_AFTER_MS;
    if (moved < MOVED_METERS && !stale) return;

    const controller = new AbortController();
    inFlight.current = true;
    lastRequestAt.current = now;
    lastRequestPos.current = { lat: fix.lat, lng: fix.lng };
    setStatus((s) => (s === "ok" ? s : "loading"));

    fetchHint(huntId, fix, controller.signal)
      .then((hint) => {
        setBand(hint.band);
        setRemaining(hint.remaining);
        setComplete(hint.complete);
        setCacheless(hint.cacheless === true);
        setReadAt(Date.now());
        setStatus("ok");
        setError(null);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
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
      });

    return () => controller.abort();
    // `tick` is the heartbeat; `fix` changing mid-interval is also a valid
    // trigger. Both are intentional dependencies.
  }, [enabled, fix, huntId, complete, tick]);

  return { band, remaining, complete, cacheless, status, error, readAt, refresh };
}
