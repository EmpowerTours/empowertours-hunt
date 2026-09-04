import { describe, expect, it } from "vitest";
import { corridorRings, decimate, ringAround } from "./corridor";
import { isWalkable, type Ring } from "./polygon";
import { haversineMeters, type LatLng } from "./distance";

const A: LatLng = { lat: 17.1614, lng: -99.5253 };

/** A straight path north, one point every `stepM` metres. */
function path(stepM: number, count: number): LatLng[] {
  return Array.from({ length: count }, (_, i) => ({
    lat: A.lat + (stepM * i) / 111_320,
    lng: A.lng,
  }));
}

describe("thinning a path", () => {
  it("keeps points at least the spacing apart", () => {
    // 100 points 2m apart; at 30m spacing only every ~15th survives.
    //
    // The FINAL gap is exempt: the endpoint is kept unconditionally, so it can
    // land closer than the spacing to the point before it. That is the rule
    // working, not a violation of it — an endpoint dropped for being too close
    // shortens the corridor at a junction.
    const kept = decimate(path(2, 100), 30);
    for (let i = 1; i < kept.length - 1; i++) {
      expect(haversineMeters(kept[i - 1], kept[i])).toBeGreaterThan(25);
    }
    expect(kept.length).toBeLessThan(12);
  });

  it("always keeps both endpoints", () => {
    // Dropping an endpoint shortens the walkable area at a junction, which is
    // exactly where somebody is most likely to be standing.
    const p = path(2, 50);
    const kept = decimate(p, 30);
    expect(kept[0]).toEqual(p[0]);
    expect(
      haversineMeters(kept[kept.length - 1], p[p.length - 1]),
    ).toBeLessThan(1);
  });

  it("handles a single point and an empty path", () => {
    expect(decimate([A], 30)).toEqual([A]);
    expect(decimate([], 30)).toEqual([]);
  });

  it("refuses a non-positive spacing", () => {
    expect(() => decimate(path(2, 5), 0)).toThrow(RangeError);
  });
});

describe("a ring around a point", () => {
  it("contains its own centre", () => {
    const area = { include: [ringAround(A, 25)], exclude: [] as Ring[] };
    expect(isWalkable(A, area)).toBe(true);
  });

  it("contains a point well inside and excludes one well outside", () => {
    const area = { include: [ringAround(A, 25)], exclude: [] as Ring[] };
    const near = { lat: A.lat + 10 / 111_320, lng: A.lng };
    const far = { lat: A.lat + 200 / 111_320, lng: A.lng };
    expect(isWalkable(near, area)).toBe(true);
    expect(isWalkable(far, area)).toBe(false);
  });

  it("does not repeat the first vertex", () => {
    // pointInRing closes the ring itself; a repeated vertex is a zero-length
    // edge, which is the kind of degenerate input a crossing test hates.
    const ring = ringAround(A, 25);
    expect(ring[0]).not.toEqual(ring[ring.length - 1]);
  });
});

describe("a corridor has no holes", () => {
  it("covers the whole path, including between ring centres", () => {
    // The failure this guards against: rings spaced too far apart leave a gap
    // mid-path, and a spawn landing there reads to a player as unreachable.
    const p = path(5, 40); // 195m of path
    const rings = corridorRings(p, { radiusM: 25, spacingM: 30 });
    const area = { include: rings, exclude: [] as Ring[] };
    for (const point of p) {
      expect(isWalkable(point, area)).toBe(true);
    }
  });

  it("refuses a spacing that would leave gaps", () => {
    // Overlap is free; a gap is only discovered by somebody standing next to
    // a spawn they cannot reach. Better to refuse the configuration.
    expect(() =>
      corridorRings(path(5, 10), { radiusM: 25, spacingM: 50 }),
    ).toThrow(RangeError);
    expect(() =>
      corridorRings(path(5, 10), { radiusM: 25, spacingM: 60 }),
    ).toThrow(/gaps/);
  });

  it("excludes ground away from the path", () => {
    const rings = corridorRings(path(5, 40), { radiusM: 25, spacingM: 30 });
    const area = { include: rings, exclude: [] as Ring[] };
    // 300m east of the line — a different street entirely.
    const off = {
      lat: A.lat,
      lng: A.lng + 300 / (111_320 * Math.cos((A.lat * Math.PI) / 180)),
    };
    expect(isWalkable(off, area)).toBe(false);
  });

  it("produces far fewer rings than the path has points", () => {
    const rings = corridorRings(path(2, 200), { radiusM: 25, spacingM: 30 });
    expect(rings.length).toBeLessThan(20);
    expect(rings.length).toBeGreaterThan(2);
  });
});
