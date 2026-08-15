import type { ClaimRefusalReason } from "./types";

/* ---------------------------------------------------------------------------
   Player-facing copy for a refused claim.

   The claim route collapses every rejection — bad fix, clock skew, cooldown,
   implausible speed, nothing in range, already found, budget exhausted — into
   ONE opaque string. That is a deliberate control, not an oversight: an
   attacker who can tell those cases apart grid-searches a hunt at ~35m spacing
   and maps every cache without walking anywhere.

   So the UI cannot explain a specific refusal, and must not guess at one. What
   it CAN do is tell the player the things the client already knows for itself
   — GPS accuracy, cooldown, whether they are signed in — which is why those
   checks live in ClaimButton and are shown BEFORE the tap, and why this copy
   points back at them instead of inventing a cause.
--------------------------------------------------------------------------- */

export interface RefusalCopy {
  title: string;
  body: string;
  /** `retry` — try again here. `move` — go elsewhere. `wait` — pause. */
  action: "retry" | "move" | "wait";
}

const REFUSALS: Record<ClaimRefusalReason, RefusalCopy> = {
  no_find_here: {
    title: "No find here",
    body: "The server does not say why, and that is on purpose — a detailed reason would let someone map the caches without walking. Check the readings above: if your accuracy is inside the limit and the band is not burning, you are simply not on it yet.",
    action: "move",
  },
  rate_limited: {
    title: "Too many attempts",
    body: "Claims are limited to a few per minute. Wait a moment, then try again — nothing was lost.",
    action: "wait",
  },
  unknown: {
    title: "Claim refused",
    body: "The server refused this claim in a way this app does not recognise. Nothing was earned and nothing was spent.",
    action: "retry",
  },
};

export function refusalCopy(reason: ClaimRefusalReason): RefusalCopy {
  return REFUSALS[reason] ?? REFUSALS.unknown;
}

/* ---------------------------------------------------------------------------
   Spawn rejections DO carry their real reason — the coordinates were published
   to this player already, so there is no secret left to protect. These are the
   `SpawnRejectReason` values from lib/hunt/spawn.ts plus the collect route's
   ceiling reasons; anything unmapped falls back to the code itself, which is
   safe to show for the same reason.
--------------------------------------------------------------------------- */

/** Keys are the exact literals in `SPAWN_DENY_REASONS` / `SPAWN_REJECT_REASONS`. */
const SPAWN_REASONS: Record<string, string> = {
  // --- Denials: mostly "not yet", never an accusation. ---
  spawn_disabled: "Spawns are switched off for this hunt.",
  no_verified_position:
    "No verified position yet. Make a claim attempt first — spawns are placed around the last fix the verifier accepted, never around a self-reported one.",
  stale_verified_position:
    "Your last verified position is too old to place a drop around. Try a claim to refresh it.",
  spawn_cooldown: "Cooling down. Another drop can appear shortly.",
  spawn_already_active: "You already have a live drop on the scope.",
  spawn_bounds_misconfigured:
    "This hunt's spawn settings are not usable. Nothing you can fix.",
  // --- Collect rejections. ---
  spawn_not_found: "That drop no longer exists.",
  spawn_expired: "It expired before the server saw your collect.",
  spawn_already_collected: "That drop was already collected.",
  out_of_range: "You are not close enough to the drop.",
  player_daily_cap_reached:
    "You have hit your rolling 24-hour MON cap. It rolls off over the next day.",
  // --- Shared with the cache verifier. ---
  player_not_active: "This wallet is not eligible to collect.",
  hunt_not_active: "This hunt is not running.",
  hunt_not_started: "This hunt has not opened yet.",
  hunt_ended: "This hunt is over.",
  hunt_budget_exhausted: "This hunt has paid out everything it was funded for.",
  gps_accuracy_too_low:
    "Your fix is too coarse to prove you were there. Step into open sky.",
  clock_skew: "Your device clock is off. Turn on automatic date and time.",
  cooldown: "Too soon after your last collect.",
  implausible_speed:
    "You covered too much ground too fast. The attempt was logged for review.",
};

export function spawnReasonCopy(reason: string): string {
  return SPAWN_REASONS[reason] ?? `Refused: ${reason}`;
}

/**
 * Reasons that will not change by waiting, so the scan poll should stop rather
 * than spend a rate-limit token every 30 seconds forever.
 */
const TERMINAL_SPAWN_REASONS = new Set([
  "spawn_disabled",
  "spawn_bounds_misconfigured",
  "player_not_active",
  "hunt_not_active",
  "hunt_ended",
]);

export function isTerminalSpawnReason(reason: string | null): boolean {
  return reason !== null && TERMINAL_SPAWN_REASONS.has(reason);
}
