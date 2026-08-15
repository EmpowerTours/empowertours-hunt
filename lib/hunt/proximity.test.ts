import { describe, it, expect } from "vitest";
import {
  bandForDistance,
  proximityHint,
  snapToGrid,
  HINT_GRID_METERS,
  type HintBand,
  type HintCandidate,
} from "./proximity";
import { haversineMeters } from "@/lib/geo/distance";

const CACHE: HintCandidate = { id: "cache-a", lat: 25.6789, lng: -100.2842 };
const SECRET = "test-grid-secret";

/** Degrees of latitude per meter. Good enough for a test fixture. */
const DEG_PER_M = 1 / 111_320;

/** A point `meters` due north of the cache. */
function north(meters: number) {
  return { lat: CACHE.lat + meters * DEG_PER_M, lng: CACHE.lng };
}

function cellKey(p: { lat: number; lng: number }): string {
  return `${p.lat.toFixed(9)}:${p.lng.toFixed(9)}`;
}

describe("bandForDistance", () => {
  it("is monotonic — moving closer never reports a colder band", () => {
    const order = ["cold", "cool", "warm", "hot", "burning"];
    const distances = [20_000, 8_000, 3_000, 600, 150, 40];
    const ranks = distances.map((d) =>
      order.indexOf(bandForDistance(d, "player-1", CACHE.id)),
    );
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1]);
    }
  });

  it("is stable across calls for the same player and cache", () => {
    // Instability would let an attacker average repeated queries to recover a
    // sharp boundary, which is worse than no jitter at all.
    const first = bandForDistance(240, "player-1", CACHE.id);
    for (let i = 0; i < 50; i++) {
      expect(bandForDistance(240, "player-1", CACHE.id)).toBe(first);
    }
  });

  it("puts a band boundary in a different place for different players", () => {
    // Probe near the nominal 250m 'hot' edge across many players; if jitter
    // works, players must disagree somewhere in the jitter window.
    const players = Array.from({ length: 40 }, (_, i) => `player-${i}`);
    const seen = new Set(players.map((p) => bandForDistance(250, p, CACHE.id)));
    expect(seen.size).toBeGreaterThan(1);
  });

  it("reports the least informative band for a non-finite distance", () => {
    expect(bandForDistance(NaN, "player-1", CACHE.id)).toBe("cold");
    expect(bandForDistance(Infinity, "player-1", CACHE.id)).toBe("cold");
  });
});

// H3(a) — one shared multiplier made the whole band ladder a single unknown:
// recover any one edge and every other edge follows from it. Each edge now
// carries its own offset.
describe("band edges are jittered independently (H3a)", () => {
  const NOMINAL: ReadonlyArray<{ band: HintBand; maxMeters: number }> = [
    { band: "burning", maxMeters: 75 },
    { band: "hot", maxMeters: 250 },
    { band: "warm", maxMeters: 1_000 },
    { band: "cool", maxMeters: 5_000 },
  ];

  /**
   * Binary-search the distance at which `band` gives way to the next one.
   * The search window is the nominal edge +/-20%, which strictly contains the
   * +/-15% jitter window and strictly excludes the neighbouring edges.
   */
  function edgeFor(
    band: HintBand,
    nominal: number,
    playerId: string,
    cacheId: string,
  ): number {
    let lo = nominal * 0.8;
    let hi = nominal * 1.2;
    expect(bandForDistance(lo, playerId, cacheId)).toBe(band);
    expect(bandForDistance(hi, playerId, cacheId)).not.toBe(band);
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      if (bandForDistance(mid, playerId, cacheId) === band) lo = mid;
      else hi = mid;
    }
    return hi;
  }

  it("does not scale every edge by the same factor", () => {
    // With the old single `multiplier`, all four ratios were identical to 12
    // decimal places for every player. Requiring them to differ for a decent
    // share of players is what fails against that.
    let playersWithDistinctRatios = 0;
    for (let i = 0; i < 30; i++) {
      const playerId = `player-${i}`;
      const ratios = NOMINAL.map(
        (e) => edgeFor(e.band, e.maxMeters, playerId, CACHE.id) / e.maxMeters,
      );
      const distinct = new Set(ratios.map((r) => r.toFixed(6)));
      if (distinct.size > 1) playersWithDistinctRatios++;
    }
    expect(playersWithDistinctRatios).toBe(30);
  });

  it("keeps the edges strictly ordered, so the ladder never inverts", () => {
    // Independent jitter is only safe because the spread (±15%) is far tighter
    // than the gap between adjacent nominal edges (the closest is 250/75).
    for (let i = 0; i < 200; i++) {
      const playerId = `player-${i}`;
      const cacheId = `cache-${i % 7}`;
      const edges = NOMINAL.map((e) =>
        edgeFor(e.band, e.maxMeters, playerId, cacheId),
      );
      for (let j = 1; j < edges.length; j++) {
        expect(edges[j]).toBeGreaterThan(edges[j - 1]);
      }
    }
  });
});

// H3(b) — the important one. Without snapping, a band edge is a circle of
// unknown radius centred on the cache, and three points determine a circle:
// ~40 binary-search probes locate a cache to sub-metre precision. Snapping the
// probe to a ~50m cell makes every point in a cell answer identically, so
// walking a boundary yields nothing finer than a cell.
describe("grid snapping defeats boundary walking (H3b)", () => {
  it("is idempotent — a snapped point snaps to itself", () => {
    const p = north(137);
    const once = snapToGrid(p, "player-1", SECRET);
    const twice = snapToGrid(once, "player-1", SECRET);
    expect(cellKey(twice)).toBe(cellKey(once));
  });

  it("moves a point by no more than a cell diagonal", () => {
    const maxOffset = HINT_GRID_METERS * Math.SQRT1_2 + 1;
    for (let i = 0; i < 300; i++) {
      const p = north(i * 3.7);
      const snapped = snapToGrid(p, "player-1", SECRET);
      expect(haversineMeters(p, snapped)).toBeLessThanOrEqual(maxOffset);
    }
  });

  it("collapses a fine-grained walk into a handful of cells", () => {
    // 400m walked in 1m steps must not produce 400 distinguishable answers.
    const cells = new Set<string>();
    for (let m = 0; m < 400; m++) {
      cells.add(cellKey(snapToGrid(north(m), "player-1", SECRET)));
    }
    expect(cells.size).toBeGreaterThan(1);
    expect(cells.size).toBeLessThanOrEqual(400 / (HINT_GRID_METERS / 2));
  });

  it("gives two probes in the same cell the SAME band even across an edge", () => {
    // The regression proper. Find a pair of nearby points whose TRUE distances
    // fall on opposite sides of a band edge but which share a snapping cell;
    // pre-snapping that pair returned two different bands and pinned the edge
    // to within half a metre.
    let straddlingPairsFound = 0;

    for (let p = 0; p < 40; p++) {
      const playerId = `player-${p}`;
      let previous: { point: ReturnType<typeof north>; band: HintBand } | null =
        null;

      for (let m = 40; m < 300; m += 0.5) {
        const point = north(m);
        const trueBand = bandForDistance(
          haversineMeters(point, CACHE),
          playerId,
          CACHE.id,
        );
        if (previous && previous.band !== trueBand) {
          const sameCell =
            cellKey(snapToGrid(previous.point, playerId, SECRET)) ===
            cellKey(snapToGrid(point, playerId, SECRET));
          if (sameCell) {
            straddlingPairsFound++;
            const a = proximityHint(previous.point, [CACHE], playerId, SECRET);
            const b = proximityHint(point, [CACHE], playerId, SECRET);
            expect(a?.band).toBe(b?.band);
          }
        }
        previous = { point, band: trueBand };
      }
    }

    // If this ever hits zero the test has stopped testing anything.
    expect(straddlingPairsFound).toBeGreaterThan(0);
  });

  it("gives every point in one cell an identical hint", () => {
    const playerId = "player-7";
    const buckets = new Map<string, Set<string>>();
    for (let m = 0; m < 600; m += 0.5) {
      const point = north(m);
      const key = cellKey(snapToGrid(point, playerId, SECRET));
      const hint = proximityHint(point, [CACHE], playerId, SECRET);
      const answers = buckets.get(key) ?? new Set<string>();
      answers.add(String(hint?.band));
      buckets.set(key, answers);
    }
    for (const answers of buckets.values()) {
      expect(answers.size).toBe(1);
    }
  });

  it("lays the lattice out differently per player and per secret", () => {
    const point = north(211);
    const a = cellKey(snapToGrid(point, "player-a", SECRET));
    const b = cellKey(snapToGrid(point, "player-b", SECRET));
    const c = cellKey(snapToGrid(point, "player-a", "another-secret"));
    // Two players cannot align their maps, and the lattice is unpredictable to
    // anyone who does not hold the server secret.
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("refuses to invent a position from non-finite input", () => {
    const snapped = snapToGrid({ lat: NaN, lng: 0 }, "player-1", SECRET);
    expect(Number.isNaN(snapped.lat)).toBe(true);
    expect(Number.isNaN(snapped.lng)).toBe(true);
    // ...and the caller ends up in the least informative band, not a plausible
    // one.
    const hint = proximityHint(
      { lat: NaN, lng: NaN },
      [CACHE],
      "player-1",
      SECRET,
    );
    expect(hint?.band).toBe("cold");
  });
});

describe("proximityHint", () => {
  it("returns null once everything is found, rather than a misleading cold", () => {
    expect(
      proximityHint({ lat: 25.6789, lng: -100.2842 }, [], "player-1", SECRET),
    ).toBeNull();
  });

  it("reports the nearest unfound cache", () => {
    const far: HintCandidate = { id: "far", lat: 19.4326, lng: -99.1332 };
    const hint = proximityHint(
      { lat: CACHE.lat, lng: CACHE.lng },
      [far, CACHE],
      "player-1",
      SECRET,
    );
    // Snapping displaces the probe by up to ~35m, well inside the burning edge
    // (75m nominal, never below 63.75m after jitter).
    expect(hint?.band).toBe("burning");
    expect(hint?.remaining).toBe(2);
  });

  it("exposes only one band regardless of how many caches remain", () => {
    // A per-cache band array would be an independent oracle per cache and
    // would let the whole set be trilaterated at once.
    const hint = proximityHint(
      { lat: 25.7, lng: -100.3 },
      [
        CACHE,
        { id: "b", lat: 25.68, lng: -100.28 },
        { id: "c", lat: 25.69, lng: -100.29 },
      ],
      "player-1",
      SECRET,
    );
    expect(Object.keys(hint ?? {}).sort()).toEqual(["band", "remaining"]);
  });
});
