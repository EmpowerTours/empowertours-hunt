import { describe, expect, it } from "vitest";
import { fixQuality, secondsLeft } from "./FixReadout";
import { GEO_FIX_TIMEOUT_MS } from "@/components/hooks/useGeolocation";

// ---------------------------------------------------------------------------
// The two decisions this panel makes without asking anyone.
//
// `fixQuality` decides whether the player is told their claim will be refused
// before they walk somewhere; `secondsLeft` decides what a player staring at an
// empty scope is told about the wait. Neither had a test, because the runner
// only ever looked at lib/.
// ---------------------------------------------------------------------------

describe("secondsLeft", () => {
  const T0 = 1_700_000_000_000;

  it("is null when no watch is running — nothing is owed, so nothing counts", () => {
    expect(secondsLeft(null, T0, GEO_FIX_TIMEOUT_MS)).toBeNull();
  });

  it("counts the device's own deadline down, not a duration of its own", () => {
    expect(secondsLeft(T0, T0, GEO_FIX_TIMEOUT_MS)).toBe(20);
    expect(secondsLeft(T0, T0 + 1_000, GEO_FIX_TIMEOUT_MS)).toBe(19);
    expect(secondsLeft(T0, T0 + 19_500, GEO_FIX_TIMEOUT_MS)).toBe(1);
  });

  it("stops at zero instead of going negative or looping back round", () => {
    expect(secondsLeft(T0, T0 + 20_000, GEO_FIX_TIMEOUT_MS)).toBe(0);
    // A phone asleep for two minutes must not read as "18s to go".
    expect(secondsLeft(T0, T0 + 120_000, GEO_FIX_TIMEOUT_MS)).toBe(0);
  });

  it("survives a clock that jumped backwards without exceeding the timeout", () => {
    const left = secondsLeft(T0, T0 - 5_000, GEO_FIX_TIMEOUT_MS);
    expect(left).not.toBeNull();
    expect(left as number).toBeGreaterThan(0);
  });
});

describe("fixQuality", () => {
  const fix = (accuracyM: number) => ({
    lat: 19.4,
    lng: -99.1,
    accuracyM,
    headingDeg: null,
    speedMps: null,
    at: 0,
  });

  it("is unknown with no fix, never 'good' by default", () => {
    expect(fixQuality(null, 30)).toBe("unknown");
  });

  it("rejects by default: a NaN accuracy is too coarse, not acceptable", () => {
    expect(fixQuality(fix(Number.NaN), 30)).toBe("too-coarse");
  });

  it("splits at the threshold and at 60% of it", () => {
    expect(fixQuality(fix(17), 30)).toBe("good");
    expect(fixQuality(fix(18), 30)).toBe("good");
    expect(fixQuality(fix(19), 30)).toBe("marginal");
    expect(fixQuality(fix(30), 30)).toBe("marginal");
    expect(fixQuality(fix(31), 30)).toBe("too-coarse");
  });
});
