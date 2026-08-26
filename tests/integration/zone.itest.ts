import "./helpers/env";
import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDatabase } from "./helpers/db";
import { makeHunt } from "./helpers/factories";
import { isWalkable, pointInRing, type Ring } from "@/lib/geo/polygon";
import { deriveSpawnInArea } from "@/lib/hunt/spawn";

/* ---------------------------------------------------------------------------
   Zone.vertices is a Json column, and the geometry is a pure function. Both
   halves are tested on their own; this is the seam between them.

   The failure it exists to catch is a quiet one. `vertices` is typed `Json` in
   Prisma and `unknown` in TypeScript, so every read is a cast — and a cast is
   an assertion, not a check. If the driver ever handed back numbers as strings,
   or reordered object keys, or lost a digit of a coordinate, `pointInRing`
   would keep returning a boolean and spawns would keep being placed. Just in
   the wrong places, on ground nobody surveyed.
--------------------------------------------------------------------------- */

// A ring around a plaza in Guanajuato, roughly 120m on a side. Deliberately
// irregular: a square would survive a transposed lat/lng, and this does not.
const PLAZA: Ring = [
  { lat: 21.017_512, lng: -101.256_781 },
  { lat: 21.018_604, lng: -101.256_402 },
  { lat: 21.018_733, lng: -101.255_117 },
  { lat: 21.017_209, lng: -101.255_338 },
];

const INSIDE = { lat: 21.018_0, lng: -101.256_0 };
const OUTSIDE = { lat: 21.020_0, lng: -101.256_0 };

describe("Zone.vertices through a real Json column", () => {
  beforeEach(resetDatabase);

  it("round-trips coordinates digit for digit", async () => {
    const hunt = await makeHunt();
    const written = await db.zone.create({
      data: { huntId: hunt.id, kind: "INCLUDE", vertices: PLAZA as never },
    });

    const read = await db.zone.findUniqueOrThrow({
      where: { id: written.id },
    });
    const ring = read.vertices as unknown as Ring;

    // Not `toEqual` on the arrays alone: that passes for "21.017512" as a
    // string too, and a string coordinate is exactly the shape of bug this
    // seam can hide.
    expect(ring).toHaveLength(PLAZA.length);
    ring.forEach((vertex, i) => {
      expect(typeof vertex.lat).toBe("number");
      expect(typeof vertex.lng).toBe("number");
      expect(vertex.lat).toBe(PLAZA[i].lat);
      expect(vertex.lng).toBe(PLAZA[i].lng);
    });
  });

  it("decides the same points after a round trip as before it", async () => {
    const hunt = await makeHunt();
    const written = await db.zone.create({
      data: { huntId: hunt.id, kind: "INCLUDE", vertices: PLAZA as never },
    });
    const stored = (
      await db.zone.findUniqueOrThrow({ where: { id: written.id } })
    ).vertices as unknown as Ring;

    // Sampled across the bounding box rather than at two hand-picked points:
    // a rounding error near one edge would slip past a two-point check.
    for (let i = 0; i <= 20; i++) {
      for (let j = 0; j <= 20; j++) {
        const point = {
          lat: 21.0165 + (i / 20) * 0.0030,
          lng: -101.2575 + (j / 20) * 0.0030,
        };
        expect(pointInRing(point, stored)).toBe(pointInRing(point, PLAZA));
      }
    }
  });

  it("keeps vertex ORDER, which is the whole shape", async () => {
    // A ring is its sequence. Postgres jsonb does not preserve object key
    // order, and if `vertices` were ever migrated from json to jsonb the array
    // would survive but a naive re-serialisation could not be trusted. This
    // fails loudly if that ever changes.
    const hunt = await makeHunt();
    const scrambled: Ring = [PLAZA[0], PLAZA[2], PLAZA[1], PLAZA[3]];
    const written = await db.zone.create({
      data: { huntId: hunt.id, kind: "INCLUDE", vertices: scrambled as never },
    });
    const stored = (
      await db.zone.findUniqueOrThrow({ where: { id: written.id } })
    ).vertices as unknown as Ring;

    expect(stored).toEqual(scrambled);

    // Order preservation is only worth asserting because order CHANGES the
    // enclosed ground: the scrambled sequence is a bow-tie, not the plaza. A
    // single sample point can fall inside both, so this looks for any point in
    // the box where the two disagree rather than assuming a chosen one does.
    let disagreements = 0;
    for (let i = 0; i <= 20; i++) {
      for (let j = 0; j <= 20; j++) {
        const point = {
          lat: 21.0165 + (i / 20) * 0.003,
          lng: -101.2575 + (j / 20) * 0.003,
        };
        if (pointInRing(point, stored) !== pointInRing(point, PLAZA)) {
          disagreements++;
        }
      }
    }
    expect(disagreements).toBeGreaterThan(0);
  });
});

describe("placement reads zones the way the spawn route does", () => {
  beforeEach(resetDatabase);

  /** The exact shape app/api/hunt/[huntId]/spawn/route.ts builds. */
  async function loadArea(huntId: string) {
    const zones = await db.zone.findMany({
      where: { huntId, active: true },
      select: { kind: true, vertices: true },
    });
    return {
      include: zones
        .filter((z) => z.kind === "INCLUDE")
        .map((z) => z.vertices as unknown as Ring),
      exclude: zones
        .filter((z) => z.kind === "EXCLUDE")
        .map((z) => z.vertices as unknown as Ring),
    };
  }

  it("places nothing for a hunt with no INCLUDE zone", async () => {
    const hunt = await makeHunt();
    const area = await loadArea(hunt.id);

    expect(area.include).toEqual([]);
    // The load-bearing reading: an unsurveyed hunt is "nowhere approved", not
    // "anywhere goes". Proven here against a real empty table rather than a
    // hand-built empty array.
    const placement = deriveSpawnInArea(
      "seed-unsurveyed",
      {
        origin: INSIDE,
        minRadiusM: 20,
        maxRadiusM: 100,
        minWei: 1n,
        maxWei: 1n,
      },
      area,
    );
    expect(placement.ok).toBe(false);
  });

  it("places inside the surveyed ring once one exists", async () => {
    const hunt = await makeHunt();
    await db.zone.create({
      data: { huntId: hunt.id, kind: "INCLUDE", vertices: PLAZA as never },
    });
    const area = await loadArea(hunt.id);

    const placement = deriveSpawnInArea(
      "seed-surveyed",
      { origin: INSIDE, minRadiusM: 5, maxRadiusM: 60, minWei: 1n, maxWei: 1n },
      area,
      50,
    );

    expect(placement.ok).toBe(true);
    if (placement.ok) {
      expect(isWalkable(placement.draw, area)).toBe(true);
      expect(pointInRing(placement.draw, PLAZA)).toBe(true);
    }
  });

  it("respects an EXCLUDE zone stored alongside the include", async () => {
    const hunt = await makeHunt();
    // A hazard covering the northern half of the plaza — the river, say.
    const hazard: Ring = [
      { lat: 21.018_2, lng: -101.257_0 },
      { lat: 21.019_2, lng: -101.257_0 },
      { lat: 21.019_2, lng: -101.254_8 },
      { lat: 21.018_2, lng: -101.254_8 },
    ];
    await db.zone.createMany({
      data: [
        { huntId: hunt.id, kind: "INCLUDE", vertices: PLAZA as never },
        { huntId: hunt.id, kind: "EXCLUDE", vertices: hazard as never },
      ],
    });
    const area = await loadArea(hunt.id);

    // Every accepted placement, over many seeds, must be outside the hazard.
    // One draw proves nothing about a filter.
    let placed = 0;
    for (let i = 0; i < 60; i++) {
      const placement = deriveSpawnInArea(
        `seed-${i}`,
        {
          origin: INSIDE,
          minRadiusM: 5,
          maxRadiusM: 80,
          minWei: 1n,
          maxWei: 1n,
        },
        area,
        40,
      );
      if (!placement.ok) continue;
      placed++;
      expect(pointInRing(placement.draw, hazard)).toBe(false);
      expect(pointInRing(placement.draw, PLAZA)).toBe(true);
    }
    expect(placed).toBeGreaterThan(0);
  });

  it("ignores a deactivated zone", async () => {
    const hunt = await makeHunt();
    await db.zone.create({
      data: {
        huntId: hunt.id,
        kind: "INCLUDE",
        vertices: PLAZA as never,
        active: false,
      },
    });

    // Deactivating the only INCLUDE zone must stop spawns, not silently widen
    // them back to the whole disc.
    expect((await loadArea(hunt.id)).include).toEqual([]);
  });
});
