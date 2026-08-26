"use client";

import { useSyncExternalStore } from "react";

/* ---------------------------------------------------------------------------
   Can this browser report a position at all?

   Answering during render rather than inside an effect is the point. The
   effect version — arm the watch, discover there is no geolocation, set state
   to say so — decides the "no GPS" branch one render later than every other
   branch, and that is the branch most likely to be hit on a phone in the
   village opened over plain http on a LAN address. Deciding it during render
   lets the button refuse instead of arming a watch that was never going to
   fire.

   It is a store rather than a constant because the SERVER cannot know the
   answer. `getServerSnapshot` says "unknown", the client corrects it on
   hydration, and the two never disagree in a way React has to warn about.
--------------------------------------------------------------------------- */

export type GeoCapability =
  /** Server render, or a client that has not been probed yet. */
  | "unknown"
  | "ok"
  /** No `navigator.geolocation` on this browser at all. */
  | "unsupported"
  /** Present but refused: geolocation needs a secure context. */
  | "insecure";

// Nothing changes the answer after load, so there is nothing to subscribe to.
// The store exists for the server/client split, not for updates.
const subscribe = () => () => {};

function probe(): GeoCapability {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return "unsupported";
  }
  if (typeof window !== "undefined" && !window.isSecureContext) {
    return "insecure";
  }
  return "ok";
}

// Probed once. `useSyncExternalStore` calls this on every render and compares
// by identity; re-probing each time would be pure waste.
let cached: GeoCapability | null = null;
const getSnapshot = (): GeoCapability => (cached ??= probe());
const getServerSnapshot = (): GeoCapability => "unknown";

export function useGeoCapability(): GeoCapability {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
