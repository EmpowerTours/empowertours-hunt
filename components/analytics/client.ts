// The PostHog client, loaded once and only when a key is set.
//
// Split out of PostHogAnalytics.tsx so that track.ts can reach the same
// instance. There must be exactly one: two inits would double every event.

import { routeName } from "./route-name";

type PostHog = (typeof import("posthog-js"))["default"];

export const KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
export const HOST =
  process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://eu.i.posthog.com";

/**
 * The resolved client, held synchronously.
 *
 * `pagehide` is the last moment a tab is alive and awaiting a promise there
 * usually loses the event, so the leave handler reads this instead. It is null
 * until the dynamic import finishes; a caller that finds null does nothing.
 */
let ready: PostHog | null = null;
let loading: Promise<PostHog | null> | null = null;

export function readyClient(): PostHog | null {
  return ready;
}

export function client(): Promise<PostHog | null> {
  if (!KEY) return Promise.resolve(null);
  loading ??= import("posthog-js")
    .then((m) => {
      m.default.init(KEY, {
        api_host: HOST,
        autocapture: false,
        disable_session_recording: true,
        capture_pageview: false,
        capture_pageleave: false,
        person_profiles: "identified_only",
        // Every one of these is pinned FALSE here rather than left to the
        // project settings, because posthog-js falls back to the server-side
        // toggle when the client says nothing — heatmaps.ts ends its isEnabled
        // check with `return this._enabledServerSide`. So a flip in the PostHog
        // UI, by anyone, would silently start capturing.
        //
        // And each of them captures $current_url from window.location, which
        // is the exact leak the manual pageview exists to avoid. The redaction
        // is only as good as "nothing else auto-captures".
        capture_heatmaps: false,
        capture_dead_clicks: false,
        capture_performance: false,
        mask_all_text: true,
        mask_all_element_attributes: true,
      });
      ready = m.default;
      return m.default;
    })
    .catch(() => {
      // An analytics vendor being unreachable must never break a page. The
      // hunter came here to trade, not to be measured.
      return null;
    });
  return loading;
}

/** The redacted route for the current page — never window.location. */
export function currentRoute(): string {
  if (typeof window === "undefined") return "/";
  return routeName(window.location.pathname);
}
