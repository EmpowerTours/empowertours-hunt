"use client";

import { useEffect } from "react";

/**
 * Hold the screen on while the player is hunting.
 *
 * WHY THIS IS NOT COSMETIC. When the screen sleeps, iOS suspends the page:
 * `setInterval` stops firing and the AudioContext moves out of "running". The
 * cache beep therefore sounds for a minute or two and then goes quiet on its
 * own, which is exactly how it was reported — and no amount of work on the
 * trigger or the volume can fix it, because nothing in the page is executing.
 *
 * It also matters without sound. GPS readings, the spawn scan and the expiry
 * countdown are all page timers; a sleeping screen freezes the instrument the
 * player is walking with.
 *
 * The lock is RELEASED BY THE BROWSER whenever the tab is hidden — switching
 * apps, taking a call — and is not restored automatically. Re-acquiring on
 * visibilitychange is the whole reason this is a hook rather than one call.
 *
 * Costs battery, obviously. Taken only while `enabled`, so a player reading
 * the hunt list is not holding their screen on.
 */
export function useScreenAwake(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    if (typeof navigator === "undefined") return;

    const api = (
      navigator as unknown as {
        wakeLock?: { request: (t: "screen") => Promise<WakeLockSentinel> };
      }
    ).wakeLock;
    // Safari before 16.4, Firefox, and any browser that has it behind a flag.
    // Nothing to fall back to: the page simply sleeps as it did before.
    if (!api) return;

    let sentinel: WakeLockSentinel | null = null;
    let dropped = false;

    const acquire = async () => {
      if (dropped || document.visibilityState !== "visible") return;
      try {
        sentinel = await api.request("screen");
      } catch {
        // Denied, low battery, or the browser decided not to. Not an error
        // the player can act on, and the hunt still works.
      }
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") void acquire();
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      dropped = true;
      document.removeEventListener("visibilitychange", onVisible);
      void sentinel?.release().catch(() => {});
      sentinel = null;
    };
  }, [enabled]);
}
