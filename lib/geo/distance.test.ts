import { describe, it, expect } from "vitest";
import { haversineMeters, withinGeofence } from "./distance";

// Parque Fundidora, Monterrey — a real place, so distances are sane.
const FUNDIDORA = { lat: 25.6789, lng: -100.2842 };

describe("haversineMeters", () => {
  it("measures a short hop to within a meter", () => {
    // 0.0002 deg of latitude is ~22.2m anywhere on Earth.
    const d = haversineMeters(FUNDIDORA, {
      lat: FUNDIDORA.lat + 0.0002,
      lng: FUNDIDORA.lng,
    });
    expect(d).toBeGreaterThan(21);
    expect(d).toBeLessThan(23);
  });

  it("is zero for identical points", () => {
    expect(haversineMeters(FUNDIDORA, FUNDIDORA)).toBe(0);
  });

  it("is symmetric", () => {
    const other = { lat: 19.4326, lng: -99.1332 };
    expect(haversineMeters(FUNDIDORA, other)).toBeCloseTo(
      haversineMeters(other, FUNDIDORA),
      6,
    );
  });

  // REGRESSION — H1. Before the clamp, `h` came out as 1.0000000000000004 for
  // this pair, Math.sqrt(h) as 1.0000000000000002, and Math.asin of that is
  // NaN. A NaN distance defeats every `distance > radius` guard downstream,
  // because NaN fails all comparisons.
  it("returns a finite distance for a near-antipodal pair (no NaN)", () => {
    const a = { lat: -59.87837783617908, lng: -74.37065036240149 };
    const b = { lat: 59.87837783617891, lng: 105.62934963759851 };
    const d = haversineMeters(a, b);
    expect(Number.isNaN(d)).toBe(false);
    expect(Number.isFinite(d)).toBe(true);
    // Half the Earth's circumference, ~20,015 km.
    expect(d).toBeGreaterThan(20_000_000);
    expect(d).toBeLessThan(20_020_000);
  });

  it("never exceeds half the great-circle circumference", () => {
    // Sweep antipodes: every one of these used to be a NaN candidate.
    const max = Math.PI * 6_371_000;
    for (let lat = -89; lat <= 89; lat += 7) {
      for (let lng = -180; lng < 180; lng += 13) {
        const d = haversineMeters(
          { lat, lng },
          { lat: -lat, lng: lng > 0 ? lng - 180 : lng + 180 },
        );
        expect(Number.isFinite(d)).toBe(true);
        expect(d).toBeLessThanOrEqual(max + 1e-6);
      }
    }
  });

  it("propagates a NaN coordinate rather than inventing a number", () => {
    // Garbage in, garbage out is correct here — the DECISION layer is where a
    // non-finite distance must be rejected, and it can only do that if the
    // NaN actually reaches it.
    expect(Number.isNaN(haversineMeters(FUNDIDORA, { lat: NaN, lng: 0 }))).toBe(
      true,
    );
  });
});

describe("withinGeofence", () => {
  it("accepts inside and rejects outside", () => {
    const target = { ...FUNDIDORA, radiusMeters: 25 };
    expect(
      withinGeofence(
        { lat: FUNDIDORA.lat + 0.0002, lng: FUNDIDORA.lng },
        target,
      ).ok,
    ).toBe(true);
    expect(
      withinGeofence(
        { lat: FUNDIDORA.lat + 0.0005, lng: FUNDIDORA.lng },
        target,
      ).ok,
    ).toBe(false);
  });

  it("treats the boundary as inside", () => {
    const target = { ...FUNDIDORA, radiusMeters: 0 };
    expect(withinGeofence(FUNDIDORA, target).ok).toBe(true);
  });

  // REGRESSION — H1. The accept condition is stated positively, so a NaN
  // distance is NOT inside. Written the other way round (`!(distance >
  // radius)`) this returns true, which is a free find from anywhere.
  it("rejects a NaN distance instead of letting it through", () => {
    const result = withinGeofence(
      { lat: NaN, lng: NaN },
      { ...FUNDIDORA, radiusMeters: 25 },
    );
    expect(result.ok).toBe(false);
    expect(Number.isNaN(result.distance)).toBe(true);
  });

  it("rejects an infinite radius claim from a NaN position", () => {
    expect(
      withinGeofence({ lat: NaN, lng: 0 }, { ...FUNDIDORA, radiusMeters: 1e9 })
        .ok,
    ).toBe(false);
  });
});
