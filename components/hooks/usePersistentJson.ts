"use client";

import { useCallback, useSyncExternalStore } from "react";

/* ---------------------------------------------------------------------------
   State that lives in localStorage.

   The obvious shape — `useState([])`, an effect that loads on mount, a second
   effect that writes on change, and a `loaded` flag so the second does not
   overwrite storage with the empty initial value before the first has run — is
   four moving parts spelling "read this key". It also renders one frame
   claiming there is nothing saved, which on the zone survey means a twenty
   minute walk appears lost every time the tab is restored.

   localStorage IS an external store, so it is read as one. The value is right
   on the first client render, there is no `loaded` flag, and a write from
   another tab shows up here.

   A FAILED WRITE IS NOT DATA LOSS. Private mode and a full quota both throw on
   `setItem`. When that happens the value is kept in memory and the key is
   marked detached, so a survey in progress keeps working on screen even though
   nothing can be persisted. Discarding the corners already walked because the
   browser refused to save them would be the worse answer by a long way.
--------------------------------------------------------------------------- */

interface Entry {
  /** The raw string this value was parsed from; the cache key for staleness. */
  raw: string | null;
  value: unknown;
  /** Storage refused the write, so memory is authoritative for this session. */
  detached: boolean;
}

const cache = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Storage access itself can throw when cookies/site data are blocked.
    return null;
  }
}

/**
 * The current value for `key`.
 *
 * MUST be identity-stable while nothing has changed. `useSyncExternalStore`
 * compares snapshots by reference and would re-render forever on a fresh
 * `JSON.parse` every call, which is what the `raw` comparison is for.
 */
function snapshot<T>(key: string, revive: (stored: unknown) => T): T {
  const hit = cache.get(key);
  if (hit?.detached) return hit.value as T;

  const raw = readRaw(key);
  if (hit && hit.raw === raw) return hit.value as T;

  let value: T;
  try {
    value = revive(raw === null ? undefined : JSON.parse(raw));
  } catch {
    // Corrupt, or someone else's JSON under our key. Fall back rather than
    // throw: an admin cannot fix a parse error from the middle of a village.
    value = revive(undefined);
  }
  cache.set(key, { raw, value, detached: false });
  return value;
}

/**
 * `useState`, persisted to localStorage under `key`.
 *
 * `revive` turns whatever was stored into a usable value and is called with
 * `undefined` when the key is empty, so it doubles as the default. It must
 * return a STABLE reference for the empty case — a module-level constant, not
 * a fresh `[]` — or the snapshot identity check cannot hold.
 */
export function usePersistentJson<T>(
  key: string,
  revive: (stored: unknown) => T,
): [T, (next: T | ((prev: T) => T)) => void] {
  const subscribe = useCallback(
    (onChange: () => void) => {
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(onChange);
      // Another tab writing this key is a real update, not a curiosity: a
      // survey screen is exactly the thing someone opens twice by accident.
      window.addEventListener("storage", onChange);
      return () => {
        set.delete(onChange);
        window.removeEventListener("storage", onChange);
      };
    },
    [key],
  );

  const getSnapshot = useCallback(() => snapshot(key, revive), [key, revive]);
  const getServerSnapshot = useCallback(() => revive(undefined), [revive]);

  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setValue = useCallback(
    (next: T | ((prev: T) => T)) => {
      const resolved =
        typeof next === "function"
          ? (next as (prev: T) => T)(snapshot(key, revive))
          : next;

      let raw: string | null = null;
      let detached = false;
      try {
        raw = JSON.stringify(resolved);
        window.localStorage.setItem(key, raw);
      } catch {
        detached = true;
      }

      cache.set(key, { raw, value: resolved, detached });
      for (const fn of listeners.get(key) ?? []) fn();
    },
    [key, revive],
  );

  return [value, setValue];
}
