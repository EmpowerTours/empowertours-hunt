"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether the viewer asked for reduced motion.
 *
 * `useSyncExternalStore` rather than an effect: matchMedia is external state,
 * this is exactly the hook for reading it, and it gives an SSR snapshot for
 * free instead of a setState-in-effect that flashes the wrong value on the
 * first paint.
 *
 * The server snapshot is `false` — full motion. Guessing "reduced" on the
 * server would park the sweep for everybody on the first frame, and a parked
 * scope reads as a crashed app.
 */
const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => {
    mq.removeEventListener("change", onChange);
  };
}

function getSnapshot(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(QUERY).matches;
}

function getServerSnapshot(): boolean {
  return false;
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
