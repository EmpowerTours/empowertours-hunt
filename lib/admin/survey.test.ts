import { describe, it, expect } from "vitest";
import {
  appendSample,
  averagePosition,
  fixQuality,
  isUsableSample,
  toCacheDraft,
  MAX_SAMPLES,
  MAX_SURVEY_ACCURACY_M,
  SAMPLE_TTL_MS,
  type Sample,
} from "./survey";
import { haversineMeters } from "@/lib/geo/distance";

// Tierra Colorada, Guerrero — where the first hunt is being surveyed.
const SPOT = { lat: 17.1614, lng: -99.5283 };
const T0 = Date.UTC(2026, 7, 15, 18, 0, 0);

function sample(
  dLat: number,
  dLng: number,
  accuracyM: number,
  tOffsetMs = 0,
): Sample {
  return {
    lat: SPOT.lat + dLat,
    lng: SPOT.lng + dLng,
    accuracyM,
    at: T0 + tOffsetMs,
  };
}

/** Eight tight fixes taken a second apart without moving. */
function settledRun(): Sample[] {
  return Array.from({ length: 8 }, (_, i) => sample(0, 0, 10, i * 1000));
}

describe("isUsableSample", () => {
  it("accepts a tight fix", () => {
    expect(isUsableSample(sample(0, 0, 8))).toBe(true);
  });

  it("rejects a fix looser than the survey ceiling", () => {
    expect(isUsableSample(sample(0, 0, MAX_SURVEY_ACCURACY_M + 1))).toBe(false);
  });

  it("rejects NaN coordinates rather than letting them through a comparison", () => {
    expect(isUsableSample({ lat: NaN, lng: 0, accuracyM: 5, at: T0 })).toBe(
      false,
    );
    expect(isUsableSample({ lat: 0, lng: NaN, accuracyM: 5, at: T0 })).toBe(
      false,
    );
    expect(isUsableSample({ ...SPOT, accuracyM: NaN, at: T0 })).toBe(false);
  });

  it("rejects a zero accuracy, which no receiver can honestly report", () => {
    expect(isUsableSample(sample(0, 0, 0))).toBe(false);
  });

  it("rejects out-of-range coordinates", () => {
    expect(isUsableSample({ lat: 91, lng: 0, accuracyM: 5, at: T0 })).toBe(
      false,
    );
    expect(isUsableSample({ lat: 0, lng: 181, accuracyM: 5, at: T0 })).toBe(
      false,
    );
  });
});

describe("averagePosition", () => {
  it("returns null with nothing to average", () => {
    expect(averagePosition([])).toBeNull();
  });

  it("returns null when every fix is unusable", () => {
    expect(averagePosition([sample(0, 0, 500), sample(0, 0, 900)])).toBeNull();
  });

  it("averages equally-weighted fixes to their midpoint", () => {
    const fix = averagePosition([
      sample(-0.0001, 0, 10),
      sample(0.0001, 0, 10),
    ]);
    expect(fix).not.toBeNull();
    expect(fix!.lat).toBeCloseTo(SPOT.lat, 9);
  });

  it("lets a 5m fix outweigh a 50m fix about a hundred to one", () => {
    // Inverse-variance weighting: 1/25 against 1/2500. The mean should sit
    // within ~1% of the tight fix, not halfway between the two.
    const fix = averagePosition([sample(0, 0, 5), sample(0.001, 0, 50)])!;
    const movedFraction = (fix.lat - SPOT.lat) / 0.001;
    expect(movedFraction).toBeGreaterThan(0);
    expect(movedFraction).toBeLessThan(0.02);
  });

  it("reports spread as the real disagreement between fixes", () => {
    // 0.0009 deg of latitude is ~100m; the mean sits midway, so the furthest
    // fix is ~50m from it.
    const fix = averagePosition([sample(0, 0, 10), sample(0.0009, 0, 10)])!;
    expect(fix.spreadM).toBeGreaterThan(45);
    expect(fix.spreadM).toBeLessThan(55);
  });

  it("reports the tightest fix as best accuracy", () => {
    expect(
      averagePosition([sample(0, 0, 30), sample(0, 0, 7)])!.bestAccuracyM,
    ).toBe(7);
  });

  it("excludes loose fixes from the mean entirely", () => {
    const fix = averagePosition([sample(0, 0, 9), sample(0.01, 0, 500)])!;
    expect(fix.samples).toBe(1);
    expect(fix.lat).toBeCloseTo(SPOT.lat, 9);
  });
});

describe("fixQuality", () => {
  it("waits until there are enough fixes to judge", () => {
    expect(fixQuality(averagePosition(settledRun().slice(0, 3)))).toBe(
      "waiting",
    );
    expect(fixQuality(null)).toBe("waiting");
  });

  it("calls a settled receiver good", () => {
    expect(fixQuality(averagePosition(settledRun()))).toBe("good");
  });

  it("calls scattered fixes rough even when there are plenty", () => {
    const scattered = Array.from({ length: 8 }, (_, i) =>
      sample(i * 0.0002, 0, 10, i * 1000),
    );
    expect(fixQuality(averagePosition(scattered))).toBe("rough");
  });
});

describe("appendSample", () => {
  it("collects fixes taken from one spot", () => {
    const buf = settledRun().reduce<Sample[]>(
      (acc, s) => appendSample(acc, s),
      [],
    );
    expect(buf).toHaveLength(8);
  });

  it("never admits an unusable fix", () => {
    const buf = settledRun().reduce<Sample[]>(
      (acc, s) => appendSample(acc, s),
      [],
    );
    expect(appendSample(buf, sample(0, 0, 900))).toHaveLength(8);
  });

  it("starts over when the operator walks off, keeping the new spot", () => {
    // Averaging two corners would yield a confident coordinate for a spot that
    // is neither — the failure that looks fine, so it must reset instead.
    const buf = settledRun().reduce<Sample[]>(
      (acc, s) => appendSample(acc, s),
      [],
    );
    const moved = appendSample(buf, sample(0.002, 0, 10, 9000)); // ~222m away
    expect(moved).toHaveLength(1);
    expect(
      haversineMeters({ lat: moved[0].lat, lng: moved[0].lng }, SPOT),
    ).toBeGreaterThan(200);
  });

  it("expires fixes left over from a previous stop", () => {
    const buf = settledRun().reduce<Sample[]>(
      (acc, s) => appendSample(acc, s),
      [],
    );
    expect(
      appendSample(buf, sample(0, 0, 10, SAMPLE_TTL_MS + 10_000)),
    ).toHaveLength(1);
  });

  it("bounds the buffer on a page left open all afternoon", () => {
    let buf: Sample[] = [];
    for (let i = 0; i < MAX_SAMPLES + 40; i++) {
      buf = appendSample(buf, sample(0, 0, 10, i * 100));
    }
    expect(buf).toHaveLength(MAX_SAMPLES);
  });
});

describe("toCacheDraft", () => {
  it("emits the strings CacheManager's form holds", () => {
    const fix = averagePosition(settledRun())!;
    const draft = toCacheDraft(fix, 25);
    expect(draft.lat).toMatch(/^-?\d+\.\d{6}$/);
    expect(draft.lng).toMatch(/^-?\d+\.\d{6}$/);
    expect(draft.radiusMeters).toBe("25");
    expect(Number(draft.lat)).toBeCloseTo(SPOT.lat, 5);
    expect(Number(draft.lng)).toBeCloseTo(SPOT.lng, 5);
  });
});
