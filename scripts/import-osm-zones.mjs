#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Import walkable ground from OpenStreetMap into a hunt's INCLUDE zones.
//
//   node scripts/import-osm-zones.mjs --hunt <id> --lat 17.1614 --lng -99.5253 \
//        --radius 2000 [--width 25] [--spacing 30] [--dry-run] [--replace]
//
// ## Why a real map and not a generated one
//
// These rings decide where a person is sent to walk, so the input has to be
// something somebody surveyed. OSM footways and residential streets were
// mapped by people who went there and can be corrected by anyone who notices
// they are wrong. A plausible-looking path that does not exist sends a player
// into a road, and no amount of confidence in the source fixes that.
//
// ## What it does NOT import
//
// Motorways, trunk roads and their link roads are excluded outright. They
// appear in OSM as `highway=*` like everything else, and a corridor along one
// is a drop on the shoulder of a road nobody should be walking on. Absent a
// reason to include a class of way, it stays out — the failure mode of a
// missing path is a smaller playable area, and of an extra one is somebody in
// traffic.
//
// Read-only against Overpass, and writes nothing without --hunt. --dry-run
// prints the counts and stops.
// ---------------------------------------------------------------------------

import { PrismaClient } from "@prisma/client";
import { corridorRings } from "../lib/geo/corridor.ts";

const OVERPASS =
  process.env.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter";

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (
    i !== -1 &&
    process.argv[i + 1] &&
    !process.argv[i + 1].startsWith("--")
  ) {
    return process.argv[i + 1];
  }
  return fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const huntId = arg("hunt");
const lat = Number(arg("lat"));
const lng = Number(arg("lng"));
const radiusM = Number(arg("radius", "2000"));
const widthM = Number(arg("width", "25"));
const spacingM = Number(arg("spacing", "30"));
const dryRun = flag("dry-run");
const replace = flag("replace");

if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
  console.error("--lat and --lng are required");
  process.exit(1);
}

// Ways a person can walk, and nothing that is mostly cars at speed. `foot=yes`
// picks up ways explicitly signed as walkable that would not otherwise match.
const QUERY = `
[out:json][timeout:60];
(
  way(around:${radiusM},${lat},${lng})[highway~"^(footway|path|pedestrian|steps|living_street|residential|service|track|cycleway|unclassified)$"];
  way(around:${radiusM},${lat},${lng})[highway][foot=yes];
);
out geom;
`;

console.log(`querying Overpass around ${lat},${lng} within ${radiusM}m…`);
const res = await fetch(OVERPASS, {
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    // Required. Overpass answers 406 Not Acceptable to Node's default
    // User-Agent — the same request from curl succeeds, which makes this look
    // like a query problem for as long as you test it with curl. Naming the
    // client and a contact address is also what their usage policy asks for.
    "user-agent": "empowertours-hunt/1.0 (admin@empowertours.xyz)",
  },
  body: `data=${encodeURIComponent(QUERY)}`,
});
if (!res.ok) {
  console.error(
    `Overpass ${res.status}. It rate-limits hard; wait a minute and retry.`,
  );
  process.exit(1);
}
const body = await res.json();
const ways = (body.elements ?? []).filter(
  (e) => e.type === "way" && Array.isArray(e.geometry),
);
console.log(`  ${ways.length} walkable ways`);

if (ways.length === 0) {
  // Not an error worth writing an empty survey for: an unsurveyed hunt at
  // least declines honestly, where a hunt with zero rings that CLAIMS to be
  // surveyed would silently place nothing and look broken.
  console.error(
    "no walkable ways found — check the coordinates, or widen --radius",
  );
  process.exit(1);
}

const rings = [];
for (const way of ways) {
  const path = way.geometry.map((g) => ({ lat: g.lat, lng: g.lon }));
  if (path.length < 2) continue;
  rings.push(...corridorRings(path, { radiusM: widthM, spacingM }));
}
console.log(
  `  ${rings.length} rings at ${widthM}m half-width, ${spacingM}m spacing`,
);

if (dryRun || !huntId) {
  console.log(
    dryRun ? "--dry-run: nothing written" : "no --hunt given: nothing written",
  );
  process.exit(0);
}

const prisma = new PrismaClient();
try {
  if (replace) {
    // Only INCLUDE. An EXCLUDE ring is somebody stating a place is unsafe, and
    // an import has no business deleting that — it is the one kind of local
    // knowledge this script cannot rediscover.
    const gone = await prisma.zone.deleteMany({
      where: { huntId, kind: "INCLUDE" },
    });
    console.log(`  removed ${gone.count} existing INCLUDE zones`);
  }
  await prisma.zone.createMany({
    data: rings.map((vertices, i) => ({
      huntId,
      kind: "INCLUDE",
      name: `osm-${i}`,
      vertices,
      active: true,
    })),
  });
  const total = await prisma.zone.count({
    where: { huntId, kind: "INCLUDE", active: true },
  });
  console.log(
    `  wrote ${rings.length}; hunt now has ${total} active INCLUDE zones`,
  );
  console.log(
    "\nSet unsurveyedSpawnRadiusM back to 0 — this hunt is surveyed now.",
  );
} finally {
  await prisma.$disconnect();
}
