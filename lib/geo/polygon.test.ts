import { describe, it, expect } from "vitest";
import { pointInRing, isWalkable, ringBounds, type Ring } from "./polygon";

// Tierra Colorada, Guerrero — the first hunt's ground, so the numbers are the
// size they will really be. ~0.002 deg is roughly 200m here.
const CENTRE = { lat: 17.1614, lng: -99.5283 };

/** An axis-aligned square of `half` degrees around a centre. */
function square(c: { lat: number; lng: number }, half: number): Ring {
  return [
    { lat: c.lat - half, lng: c.lng - half },
    { lat: c.lat - half, lng: c.lng + half },
    { lat: c.lat + half, lng: c.lng + half },
    { lat: c.lat + half, lng: c.lng - half },
  ];
}

const PLAZA = square(CENTRE, 0.002);

describe("pointInRing", () => {
  it("accepts the centre of a square", () => {
    expect(pointInRing(CENTRE, PLAZA)).toBe(true);
  });

  it("rejects a point outside", () => {
    expect(
      pointInRing({ lat: CENTRE.lat + 0.01, lng: CENTRE.lng }, PLAZA),
    ).toBe(false);
  });

  it("rejects a point just beyond an edge", () => {
    expect(
      pointInRing({ lat: CENTRE.lat, lng: CENTRE.lng + 0.0021 }, PLAZA),
    ).toBe(false);
  });

  it("accepts a point just inside an edge", () => {
    expect(
      pointInRing({ lat: CENTRE.lat, lng: CENTRE.lng + 0.0019 }, PLAZA),
    ).toBe(true);
  });

  // A U-shape: the notch between the arms is outside the polygon even though it
  // sits within the bounding box. Ray casting has to get this right or a spawn
  // lands in whatever the notch represents — typically the river the hull was
  // drawn around.
  it("rejects a point in the notch of a concave ring", () => {
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
    expect(pointInRing({ lat: 17.1638, lng: -99.526 }, u)).toBe(false);
    expect(pointInRing({ lat: 17.161, lng: -99.526 }, u)).toBe(true);
  });

  // A horizontal edge shares its latitude with the test point. The straddle
  // check must short-circuit before the division, or this is 0/0 = NaN.
  it("survives an edge at exactly the point's latitude", () => {
    const flat: Ring = [
      { lat: 17.16, lng: -99.53 },
      { lat: 17.16, lng: -99.52 },
      { lat: 17.17, lng: -99.52 },
      { lat: 17.17, lng: -99.53 },
    ];
    expect(() => pointInRing({ lat: 17.16, lng: -99.525 }, flat)).not.toThrow();
    expect(pointInRing({ lat: 17.165, lng: -99.525 }, flat)).toBe(true);
  });

  it("contains nothing when the ring is degenerate", () => {
    expect(pointInRing(CENTRE, [])).toBe(false);
    expect(pointInRing(CENTRE, [CENTRE])).toBe(false);
    expect(pointInRing(CENTRE, [CENTRE, { lat: 17.17, lng: -99.52 }])).toBe(
      false,
    );
  });

  // NaN must fall out as "not inside". This codebase has already been bitten
  // once by a NaN sailing through a geofence because the reject condition was
  // stated instead of the accept condition.
  it("rejects a non-finite point", () => {
    expect(pointInRing({ lat: NaN, lng: -99.5283 }, PLAZA)).toBe(false);
    expect(pointInRing({ lat: 17.1614, lng: NaN }, PLAZA)).toBe(false);
    expect(pointInRing({ lat: Infinity, lng: -99.5283 }, PLAZA)).toBe(false);
  });

  // Zone.vertices is a Prisma `Json` column, so a hand-edited row can hold
  // anything at all. Malformed shapes must reject, never throw — a throw here
  // would surface as a 500 inside spawn placement.
  it("rejects malformed vertex data without throwing", () => {
    const junk = [
      null,
      undefined,
      {},
      "not a ring",
      42,
      [1, 2, 3],
      [
        { lat: "17.16", lng: "-99.53" },
        { lat: 17.17, lng: -99.52 },
        { lat: 17.18, lng: -99.51 },
      ],
      [null, null, null],
    ];
    for (const bad of junk) {
      expect(() => pointInRing(CENTRE, bad as unknown as Ring)).not.toThrow();
      expect(pointInRing(CENTRE, bad as unknown as Ring)).toBe(false);
    }
  });

  it("rejects a ring with a non-finite or out-of-range vertex", () => {
    const bad: Ring = [
      { lat: 17.16, lng: -99.53 },
      { lat: NaN, lng: -99.52 },
      { lat: 17.17, lng: -99.52 },
    ];
    expect(pointInRing(CENTRE, bad)).toBe(false);

    const offGlobe: Ring = [
      { lat: 17.16, lng: -99.53 },
      { lat: 91, lng: -99.52 },
      { lat: 17.17, lng: -99.52 },
    ];
    expect(pointInRing(CENTRE, offGlobe)).toBe(false);
  });
});

describe("isWalkable", () => {
  const area = { include: [PLAZA], exclude: [] as Ring[] };

  it("accepts inside the hull", () => {
    expect(isWalkable(CENTRE, area)).toBe(true);
  });

  it("rejects outside the hull", () => {
    expect(isWalkable({ lat: CENTRE.lat + 0.01, lng: CENTRE.lng }, area)).toBe(
      false,
    );
  });

  // THE POINT OF THE WHOLE MODULE: the river runs through the plaza's bounding
  // box and must stay unreachable even though the hull covers it.
  it("lets an exclusion beat the hull", () => {
    const river = square({ lat: CENTRE.lat, lng: CENTRE.lng + 0.001 }, 0.0003);
    const withRiver = { include: [PLAZA], exclude: [river] };

    expect(
      isWalkable({ lat: CENTRE.lat, lng: CENTRE.lng + 0.001 }, withRiver),
    ).toBe(false);
    expect(isWalkable(CENTRE, withRiver)).toBe(true);
  });

  // An unsurveyed hunt must place nothing. "No polygons yet" is what a
  // half-finished survey looks like, and it must never read as "anywhere goes".
  it("rejects everything when no include ring is configured", () => {
    expect(isWalkable(CENTRE, { include: [], exclude: [] })).toBe(false);
  });

  it("accepts a point in any one of several disjoint areas", () => {
    const market = square({ lat: 17.1629, lng: -99.5271 }, 0.0005);
    const twoAreas = { include: [PLAZA, market], exclude: [] as Ring[] };

    expect(isWalkable({ lat: 17.1629, lng: -99.5271 }, twoAreas)).toBe(true);
    expect(isWalkable(CENTRE, twoAreas)).toBe(true);
    expect(isWalkable({ lat: 17.19, lng: -99.5 }, twoAreas)).toBe(false);
  });

  it("rejects a non-finite point regardless of configuration", () => {
    expect(isWalkable({ lat: NaN, lng: NaN }, area)).toBe(false);
  });
});

describe("ringBounds", () => {
  it("returns the extent of a usable ring", () => {
    const b = ringBounds(PLAZA)!;
    expect(b.minLat).toBeCloseTo(CENTRE.lat - 0.002, 9);
    expect(b.maxLat).toBeCloseTo(CENTRE.lat + 0.002, 9);
    expect(b.minLng).toBeCloseTo(CENTRE.lng - 0.002, 9);
    expect(b.maxLng).toBeCloseTo(CENTRE.lng + 0.002, 9);
  });

  it("returns null for a degenerate ring", () => {
    expect(ringBounds([])).toBeNull();
    expect(ringBounds([CENTRE, CENTRE])).toBeNull();
  });
});
