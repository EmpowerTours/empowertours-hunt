// The only way this app emits a product event.
//
// WHY IT IS A CLOSED API AND NOT A THIN WRAPPER. PostHog's `capture` takes any
// object, and on these screens the nearest variable to hand is usually a wallet
// address, a leash digest or a dollar amount. So no call site gets to choose
// what is sent: each function below accepts a value from a union, and the
// properties are built here. Adding a new event means editing this file, which
// is the point — it is one place to review rather than forty.
//
// WHAT IS NEVER SENT, and cannot be:
//   wallet addresses     — identifies the person, permanently and publicly
//   leash digests        — unique per signature, so a de-facto identifier
//   transaction hashes   — same
//   amounts and prices   — the hunter's own money, and a funnel does not need it
//   anything free-text   — a note, a market name typed by hand, an error body
//
// What IS sent is categorical and small: which step happened, on which route
// (already redacted), and a couple of enum-valued facts about it. That is
// enough for a funnel and for retention, which is all these are for.
//
// EVENT NAMES follow DeltaV's taxonomy so its benchmarks apply, with the
// domain detail carried in properties rather than in the event name.

import { client, KEY, currentRoute } from "./client";

/** A repeat of the core loop. */
export type CoreAction = "leash_signed" | "order_placed" | "position_closed";

/** A named non-core feature. */
export type Feature =
  | "autonomy_granted"
  | "kimi_suggestion"
  | "private_note"
  | "swap_mon_to_ausd"
  | "swap_usdc_to_ausd"
  | "results_viewed";

/** Values allowed as a property. Deliberately not `unknown`. */
type Scalar = string | number | boolean;

function emit(event: string, props: Record<string, Scalar>): void {
  if (!KEY) return;
  // Fire-and-forget. A failure here must never surface to the hunter, and
  // must never block the action that triggered it.
  void client()
    .then((ph) => {
      ph?.capture(event, { ...props, route: currentRoute() });
    })
    .catch(() => {});
}

/**
 * The first time this browser completes the core job — signing a leash.
 *
 * Guarded by localStorage, so it is once per BROWSER rather than once per
 * person: a hunter on a second device counts twice, and one who clears storage
 * counts again. Stated rather than hidden, because the alternative is asking
 * the server "is this their first?" on a path that must not block on a network
 * call. `core_action` is emitted every time regardless, so nothing is lost —
 * first-touch can always be recomputed from those if this proves too loose.
 */
export function trackActivation(jtbdName: string): void {
  if (!KEY) return;
  try {
    if (window.localStorage.getItem("ph_activated") === "1") return;
    window.localStorage.setItem("ph_activated", "1");
  } catch {
    // Private window, or storage blocked. Emitting a possibly-duplicate
    // activation is better than emitting none.
  }
  emit("activation", { jtbd_name: jtbdName });
}

export function trackCoreAction(
  action: CoreAction,
  props: Record<string, Scalar> = {},
): void {
  emit("core_action", { action_type: action, ...props });
}

export function trackFeature(
  feature: Feature,
  props: Record<string, Scalar> = {},
): void {
  emit("feature_engaged", { feature_name: feature, ...props });
}

/**
 * First successful sign-in on this browser.
 *
 * Same localStorage caveat as activation. `source` is how the wallet was
 * derived, never who it belongs to.
 */
export function trackSignup(source: string): void {
  if (!KEY) return;
  try {
    if (window.localStorage.getItem("ph_signed_up") === "1") return;
    window.localStorage.setItem("ph_signed_up", "1");
  } catch {
    return;
  }
  emit("signup_completed", { source });
}

/** Once per PostHog session, for a signed-in hunter. */
export function trackSessionStarted(): void {
  if (!KEY) return;
  try {
    if (window.sessionStorage.getItem("ph_session_evt") === "1") return;
    window.sessionStorage.setItem("ph_session_evt", "1");
  } catch {
    return;
  }
  emit("session_started", {});
}
