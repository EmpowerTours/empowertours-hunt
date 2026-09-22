// When the scope should ask again.
//
// Pure, and in its own file with no React import, so it can be tested in the
// node environment the runner uses — the same reason components/hunt/format.ts
// and fixQuality live apart from the screens that call them.
//
// ## Why this exists at all
//
// The rule it encodes used to be a condition inside an effect, and it was
// wrong in a way no type could catch: `complete` ENDED polling. The effect
// returned early on it, nothing ever reset it, and so the scope went dead for
// the life of the mounted page.
//
// That is guaranteed wrong for the Sembrador workflow, which is "plant a
// cache, then walk to it": the app is already open and already complete at the
// moment the new cache appears. Measured on the live hunt 2026-09-22 — found
// the only cache at 01:09, last hint request 02:37, cache planted 02:40, then
// the player stood 2m from it for half an hour with check-ins landing normally
// and the scope still reading "that was the last one".

export const MIN_INTERVAL_MS = 6_000;
export const STALE_AFTER_MS = 12_000;
export const MOVED_METERS = 15;
export const BACKOFF_MS = 20_000;

/**
 * How often to keep asking once there is nothing left to find.
 *
 * One a minute, against a route that allows twelve. Slow enough that a
 * finished hunt costs almost nothing, fast enough that a newly planted cache
 * is announced before anybody gives up on it.
 */
export const COMPLETE_INTERVAL_MS = 60_000;

export interface HintScheduleInput {
  enabled: boolean;
  /** Null until the device has produced a position. */
  hasFix: boolean;
  inFlight: boolean;
  /** Nothing left to find, as the server last reported it. */
  complete: boolean;
  now: number;
  lastRequestAt: number;
  /** Set while backing off from a 429. */
  blockedUntil: number;
  /** Metres since the position the last request was made from. */
  movedMeters: number;
}

/**
 * Should the scope send a hint request right now?
 *
 * Reject by default, per AGENTS.md rule 2: every gate is written as "not
 * clearly allowed" rather than "clearly forbidden", so a NaN distance or a NaN
 * clock lands on "do not ask" instead of on a request per heartbeat.
 */
export function shouldRequestHint(i: HintScheduleInput): boolean {
  if (!i.enabled) return false;
  if (!i.hasFix) return false;
  if (i.inFlight) return false;
  if (!(i.now >= i.blockedUntil)) return false;

  const interval = i.complete ? COMPLETE_INTERVAL_MS : MIN_INTERVAL_MS;
  if (!(i.now - i.lastRequestAt >= interval)) return false;

  // Movement is the trigger only while there is something to find. Once the
  // hunt is complete the interesting change is at the OTHER end — somebody
  // planting a cache — so a player who has not moved must still be told, or
  // standing still becomes a way of never hearing about it.
  if (i.complete) return true;

  const stale = i.now - i.lastRequestAt > STALE_AFTER_MS;
  if (stale) return true;
  return i.movedMeters >= MOVED_METERS;
}
