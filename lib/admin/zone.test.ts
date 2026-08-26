import { describe, it, expect } from "vitest";
import {
  ringPerimeterMeters,
  ringAreaSquareMeters,
  isSimpleRing,
  validateRing,
  MAX_RING_VERTICES,
} from "./zone";
import type { Ring } from "@/lib/geo/polygon";

// Tierra Colorada, Guerrero.
const CENTRE = { lat: 17.1614, lng: -99.5283 };

/** Square of side ~`meters`, centred on `c`. */
function squareOfSide(c: { lat: number; lng: number }, meters: number): Ring {
  const halfLat = meters / 2 / 110_540;
  const halfLng = meters / 2 / (111_320 * Math.cos((c.lat * Math.PI) / 180));
  return [
    { lat: c.lat - halfLat, lng: c.lng - halfLng },
    { lat: c.lat - halfLat, lng: c.lng + halfLng },
    { lat: c.lat + halfLat, lng: c.lng + halfLng },
    { lat: c.lat + halfLat, lng: c.lng - halfLng },
  ];
}

describe("ringAreaSquareMeters", () => {
  it("measures a 100m square to within a couple of percent", () => {
    const a = ringAreaSquareMeters(squareOfSide(CENTRE, 100));
    expect(a).toBeGreaterThan(9_700);
    expect(a).toBeLessThan(10_300);
  });

  it("is orientation-independent", () => {
    const ring = squareOfSide(CENTRE, 100);
    const reversed = [...ring].reverse();
    expect(ringAreaSquareMeters(reversed)).toBeCloseTo(
      ringAreaSquareMeters(ring),
      3,
    );
  });

  it("is zero for a degenerate ring", () => {
    expect(ringAreaSquareMeters([])).toBe(0);
    expect(ringAreaSquareMeters([CENTRE, CENTRE])).toBe(0);
  });
});

describe("ringPerimeterMeters", () => {
  it("walks all four sides including the closing edge", () => {
    const p = ringPerimeterMeters(squareOfSide(CENTRE, 100));
    expect(p).toBeGreaterThan(390);
    expect(p).toBeLessThan(410);
  });
});

describe("isSimpleRing", () => {
  it("accepts a square", () => {
    expect(isSimpleRing(squareOfSide(CENTRE, 100))).toBe(true);
  });

  it("accepts a concave outline", () => {
    const u: Ring = [
      { lat: 17.16, lng: -99.53 },
      { lat: 17.16, lng: -99.52 },
      { lat: 17.165, lng: -99.52 },
      { lat: 17.165, lng: -99.525 },
      { lat: 17.162, lng: -99.525 },
      { lat: 17.162, lng: -99.527 },
      { lat: 17.165, lng: -99.527 },
      { lat: 17.165, lng: -99.53 },
    ];
    expect(isSimpleRing(u)).toBe(true);
  });

  // A bowtie: ray casting answers confidently and gets half the shape backwards.
  // This is the survey mistake of walking a route that doubles back on itself.
  it("rejects a figure-eight", () => {
    const bowtie: Ring = [
      { lat: 17.16, lng: -99.53 },
      { lat: 17.17, lng: -99.52 },
      { lat: 17.16, lng: -99.52 },
      { lat: 17.17, lng: -99.53 },
    ];
    expect(isSimpleRing(bowtie)).toBe(false);
  });

  it("rejects malformed input without throwing", () => {
    for (const bad of [null, undefined, {}, "ring", [1, 2, 3]]) {
      expect(() => isSimpleRing(bad as unknown as Ring)).not.toThrow();
      expect(isSimpleRing(bad as unknown as Ring)).toBe(false);
    }
  });
});

describe("validateRing", () => {
  it("accepts a village-sized square and reports its stats", () => {
    const result = validateRing(squareOfSide(CENTRE, 200));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.vertices).toBe(4);
      expect(result.areaSquareMeters).toBeGreaterThan(38_000);
      expect(result.perimeterMeters).toBeGreaterThan(780);
    }
  });

  it("needs at least three corners", () => {
    const r = validateRing([CENTRE, { lat: 17.17, lng: -99.52 }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toBe("too_few_vertices");
  });

  it("refuses a self-intersecting outline", () => {
    const bowtie: Ring = [
      { lat: 17.16, lng: -99.53 },
      { lat: 17.17, lng: -99.52 },
      { lat: 17.16, lng: -99.52 },
      { lat: 17.17, lng: -99.53 },
    ];
    const r = validateRing(bowtie);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toBe("self_intersecting");
  });

  // A zone smaller than the error bars of the fixes that drew it is noise.
  it("refuses a ring inside GPS error", () => {
    const r = validateRing(squareOfSide(CENTRE, 10));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toBe("too_small");
  });

  // The classic survey slip: one corner left behind at the last location.
  it("refuses a ring stretched across a region", () => {
    const strayCorner: Ring = [
      { lat: 17.16, lng: -99.53 },
      { lat: 17.17, lng: -99.52 },
      { lat: 19.43, lng: -99.13 },
    ];
    const r = validateRing(strayCorner);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toBe("too_large");
  });

  it("refuses a corner that is off the globe or non-numeric", () => {
    const r = validateRing([
      { lat: 17.16, lng: -99.53 },
      { lat: 91, lng: -99.52 },
      { lat: 17.17, lng: -99.51 },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toBe("invalid_vertex");
  });

  it("refuses an oversized payload", () => {
    const many = Array.from({ length: MAX_RING_VERTICES + 1 }, (_, i) => ({
      lat: CENTRE.lat + i * 1e-6,
      lng: CENTRE.lng,
    }));
    const r = validateRing(many);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toBe("too_many_vertices");
  });

  it("refuses malformed input without throwing", () => {
    for (const bad of [null, undefined, {}, "ring"]) {
      expect(() => validateRing(bad as unknown as Ring)).not.toThrow();
      expect(validateRing(bad as unknown as Ring).ok).toBe(false);
    }
  });
});
