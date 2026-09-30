"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useAuthSlot } from "@/app/providers";
import { client, readyClient, KEY } from "./client";
import { routeName } from "./route-name";
import { trackSessionStarted, trackSignup } from "./track";

// ---------------------------------------------------------------------------
// Product analytics, configured for an app that holds passkeys and wallets.
//
// INERT WITHOUT A KEY. No NEXT_PUBLIC_POSTHOG_KEY, no init, no network, and
// the SDK chunk is never even fetched — see client.ts.
//
// WHAT IS TURNED OFF, AND WHY EACH ONE MATTERS ON THESE SCREENS:
//
//   autocapture       — off. It attaches the text of clicked elements, and
//                       hunt/wallet/ProgressPanel.tsx renders a full wallet
//                       address as visible text.
//   session recording — off. It replays the DOM, and cota/trade/page.tsx has a
//                       textarea for a note the UI promises is sealed in the
//                       browser and unreadable by the server. Recording it
//                       would make that sentence false.
//   capture_pageview  — off, replaced below by a manual capture of a REDACTED
//                       route. PostHog's own reads window.location, and some
//                       of this app's links carry single-use tokens.
//   person_profiles   — "identified_only", and nothing calls identify(). Every
//                       event is anonymous.
//
// Product events go through track.ts, which is a closed API: call sites pick
// from a union and cannot pass a wallet address, a digest or an amount.
// ---------------------------------------------------------------------------

export function PostHogAnalytics() {
  const pathname = usePathname();
  const auth = useAuthSlot();

  useEffect(() => {
    if (!KEY || pathname === null) return;
    let live = true;
    let left = false;
    const route = routeName(pathname);
    // Set explicitly, here and on the leave below. Left alone, PostHog reads
    // window.location and would ship the query string.
    const props = {
      $current_url: window.location.origin + route,
      $pathname: route,
    };

    void client().then((ph) => {
      if (!live || !ph) return;
      ph.capture("$pageview", props);
    });

    /**
     * Paired with the view above, because PostHog's web analytics derives
     * session duration and bounce rate from the two together. Fires once per
     * view: whichever of a route change or a tab closing happens first wins.
     */
    const leave = () => {
      if (left) return;
      left = true;
      readyClient()?.capture("$pageleave", props);
    };

    // pagehide covers closing, navigating away and bfcache. visibilitychange
    // covers backgrounding, which on a phone is how most sessions really end —
    // and this app is used outdoors, one-handed.
    const onHidden = () => {
      if (document.visibilityState === "hidden") leave();
    };
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", onHidden);

    return () => {
      live = false;
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", onHidden);
      leave();
    };
  }, [pathname]);

  // Sign-in lifecycle. "passkey" is how the wallet is derived — a Mera key
  // from a WebAuthn PRF — never whose it is.
  useEffect(() => {
    if (auth.status !== "signed-in") return;
    trackSignup("passkey");
    trackSessionStarted();
  }, [auth.status]);

  return null;
}
