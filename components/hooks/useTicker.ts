"use client";

import { useEffect, useState } from "react";

/**
 * One interval for the whole screen.
 *
 * Spawn countdowns, fix-age readouts and the claim cooldown all need a
 * ticking clock. Giving each its own `setInterval` would wake the CPU N times a
 * second on a phone that is already running a high-accuracy GPS watch, which is
 * the single most expensive thing this app does to a battery.
 */
export function useTicker(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, enabled]);

  return now;
}

/**
 * True once the component has mounted on the client.
 *
 * Used to gate anything whose first render would otherwise differ between
 * server and client (clock readouts, `matchMedia`), rather than reaching for
 * `suppressHydrationWarning` and hiding a real mismatch.
 */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
