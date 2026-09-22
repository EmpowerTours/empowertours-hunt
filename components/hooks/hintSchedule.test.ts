import { describe, expect, it } from "vitest";
import {
  COMPLETE_INTERVAL_MS,
  MIN_INTERVAL_MS,
  MOVED_METERS,
  shouldRequestHint,
  type HintScheduleInput,
} from "./hintSchedule";

/* ---------------------------------------------------------------------------
   The bug this file exists for.

   `complete` used to END polling: the effect returned early on it and nothing
   reset the flag, so the scope went dead for the life of the mounted page.

   Measured on the live hunt 2026-09-22 — found the only cache at 01:09:40,
   last hint request 02:37:52, second cache planted 02:40:44. The player then
   stood 2 metres from it for half an hour with check-ins landing normally,
   while the scope read "that was the last one". Only a reload would clear it.

   That is not an edge case. It is the Sembrador workflow: plant a cache, then
   walk to it. The app is already open and already complete when the cache
   appears.
--------------------------------------------------------------------------- */

const base: HintScheduleInput = {
  enabled: true,
  hasFix: true,
  inFlight: false,
  complete: false,
  now: 1_000_000,
  lastRequestAt: 0,
  blockedUntil: 0,
  movedMeters: 0,
};
const ask = (over: Partial<HintScheduleInput> = {}) =>
  shouldRequestHint({ ...base, ...over });

describe("shouldRequestHint", () => {
  it("asks on the first reading", () => {
    expect(ask({ movedMeters: Infinity })).toBe(true);
  });

  it("refuses when disabled, without a fix, or mid-request", () => {
    expect(ask({ enabled: false })).toBe(false);
    expect(ask({ hasFix: false })).toBe(false);
    expect(ask({ inFlight: true })).toBe(false);
  });

  it("respects a 429 backoff", () => {
    expect(ask({ blockedUntil: base.now + 1 })).toBe(false);
    expect(ask({ blockedUntil: base.now })).toBe(true);
  });

  // ---- The regression, stated as the thing that was false.
  it("KEEPS ASKING once the hunt is complete", () => {
    const lastRequestAt = base.now - COMPLETE_INTERVAL_MS;
    expect(ask({ complete: true, lastRequestAt })).toBe(true);
  });

  it("asks while complete even though the player has not moved", () => {
    expect(
      ask({
        complete: true,
        movedMeters: 0,
        lastRequestAt: base.now - COMPLETE_INTERVAL_MS,
      }),
    ).toBe(true);
  });

  // Standing still must not be a way of never hearing about a new cache —
  // which is exactly the position the live player was in.
  it("announces a cache planted under a standing player", () => {
    let lastRequestAt = base.now;
    let asked = 0;
    for (let t = 0; t <= 5 * COMPLETE_INTERVAL_MS; t += 2_000) {
      const now = base.now + t;
      if (
        shouldRequestHint({
          ...base,
          complete: true,
          movedMeters: 0,
          now,
          lastRequestAt,
        })
      ) {
        asked++;
        lastRequestAt = now;
      }
    }
    expect(asked).toBe(5);
  });

  it("polls a completed hunt far more slowly than a live one", () => {
    const justUnder = base.now - (COMPLETE_INTERVAL_MS - 1_000);
    expect(ask({ complete: true, lastRequestAt: justUnder })).toBe(false);
    // The same gap is plenty while there is still something to find.
    expect(
      ask({
        complete: false,
        lastRequestAt: justUnder,
        movedMeters: MOVED_METERS,
      }),
    ).toBe(true);
  });

  it("holds the normal floor between readings", () => {
    expect(
      ask({
        lastRequestAt: base.now - (MIN_INTERVAL_MS - 1),
        movedMeters: Infinity,
      }),
    ).toBe(false);
  });

  it("needs movement or staleness while hunting", () => {
    const lastRequestAt = base.now - MIN_INTERVAL_MS;
    expect(ask({ lastRequestAt, movedMeters: MOVED_METERS - 1 })).toBe(false);
    expect(ask({ lastRequestAt, movedMeters: MOVED_METERS })).toBe(true);
  });

  // Reject by default (AGENTS.md rule 2): a NaN must not become a request on
  // every heartbeat.
  it("refuses on an unusable distance or clock", () => {
    const lastRequestAt = base.now - MIN_INTERVAL_MS;
    expect(ask({ lastRequestAt, movedMeters: NaN })).toBe(false);
    expect(ask({ now: NaN })).toBe(false);
  });
});
