"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { routeName } from "./route-name";

// Type-only, so importing it emits nothing into the bundle.
type PostHog = (typeof import("posthog-js"))["default"];

// ---------------------------------------------------------------------------
// Product analytics, configured for an app that holds passkeys and wallets.
//
// WHY IT EXISTS. DeltaV's Demo Day application gates on connecting an
// analytics source, and this repo had none of any kind. It is also simply
// true that nobody knows which screens get used.
//
// INERT WITHOUT A KEY. No NEXT_PUBLIC_POSTHOG_KEY, no init, no network. That
// is the default, so merging this changes nothing until somebody deliberately
// sets the variable.
//
// WHAT IS TURNED OFF, AND WHY EACH ONE MATTERS HERE:
//
//   autocapture            — off. On by default, it records clicks and the
//                            text of the elements clicked. On these screens
//                            that is wallet addresses, balances and amounts.
//   session recording      — off. It replays the DOM. This app renders a
//                            passkey flow and a private note; there is no
//                            version of recording that is acceptable.
//   capture_pageview       — off, and replaced below by a manual capture that
//                            sends a REDACTED route. PostHog's own pageview
//                            reads window.location, which on this app carries
//                            hunt ids, player ids and single-use tokens.
//   person_profiles        — "identified_only", and nothing ever calls
//                            identify(). So every event is anonymous and no
//                            person record is created.
//
// WHAT IT DOES SEND: a page-view event per navigation, carrying the route
// SHAPE (/hunt/:id, never /hunt/<real id>) and nothing else. That is enough
// for the funnel and retention numbers an application asks for, and it is the
// least that can answer them.
//
// IF SOMEBODY LATER WANTS RICHER EVENTS: add explicit posthog.capture() calls
// with hand-written properties. Do not turn autocapture back on to get them.
//
// THE SDK IS LOADED DYNAMICALLY, and only when a key is set. A static import
// would put ~200KB of vendor code into the bundle of every page for a feature
// that is off, on an app whose users are on phones on Mexican mobile data.
// With no key the chunk is never requested at all.
// ---------------------------------------------------------------------------

const KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
// EU, to match where everything else already is: hunt-web AND Postgres both
// run in Railway's europe-west4, so the player rows, wallet addresses and fills
// are already under EU jurisdiction. Sending analytics to the US cloud would
// split residency across two jurisdictions for no benefit — the two PostHog
// clouds are wholly independent instances and moving a project between them
// later needs their Scale plan and one of their engineers, so this is not a
// decision that can be revisited cheaply.
//
// This does NOT route through Railway. Capture is browser-to-PostHog directly,
// so the region affects jurisdiction, never latency.
//
// It MUST match the region the PostHog account was created in. A mismatch does
// not error — the events simply go nowhere.
const HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://eu.i.posthog.com";

/**
 * Loaded once, on first use, and only with a key. Held at module scope so a
 * remount does not re-import or re-init.
 */
let loading: Promise<PostHog | null> | null = null;

function client(): Promise<PostHog | null> {
  if (!KEY) return Promise.resolve(null);
  loading ??= import("posthog-js")
    .then((m) => {
      m.default.init(KEY, {
        api_host: HOST,
        autocapture: false,
        disable_session_recording: true,
        capture_pageview: false,
        capture_pageleave: false,
        // Never identified, so never a person profile.
        person_profiles: "identified_only",
        // Belt and braces: if a future edit ever enables recording, it still
        // cannot read text or inputs.
        mask_all_text: true,
        mask_all_element_attributes: true,
      });
      return m.default;
    })
    .catch(() => {
      // An analytics vendor being unreachable must never break a page. The
      // hunter came here to trade, not to be measured.
      return null;
    });
  return loading;
}

export function PostHogAnalytics() {
  const pathname = usePathname();

  useEffect(() => {
    if (!KEY || pathname === null) return;
    let live = true;
    const route = routeName(pathname);
    void client().then((ph) => {
      if (!live || !ph) return;
      ph.capture("$pageview", {
        // Set explicitly. Left alone, PostHog reads window.location and would
        // ship the query string — which on some routes is a single-use token.
        $current_url: window.location.origin + route,
        $pathname: route,
      });
    });
    return () => {
      live = false;
    };
  }, [pathname]);

  return null;
}
