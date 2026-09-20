import { describe, it } from "vitest";
import {
  canAfford,
  deriveEdition,
  quotedPrice,
  type EditionOffer,
} from "./edition";
import { haversineMeters } from "@/lib/geo/distance";

/* ---------------------------------------------------------------------------
   A SIMULATION, not a test of correctness.

   Kept, not scratch. It answers the question that had to be settled before
   the take route was written — with the real placement draw, the real
   catalogue and the real hunt economics, does a hunter ever get to buy
   anything? — and it keeps answering it when the prices change.

   Re-run it after any price change on the venue. The numbers in the comment
   below are what was true on 2026-09-20; the printout is what is true now.

   Every number below is measured, not assumed:
     catalogue  music.empowertours.xyz/api/catalogue, 2026-09-20 — 6 active
                masters, 35 to 300 WMON
     spawns     the live "Cualquier Ciudad" hunt pays exactly 1 MON per spawn
                (spawnMinWei == spawnMaxWei == 1e18) in a 35-60m annulus
     cadence    cooldownSeconds 60, so one spawn a minute is the ceiling

   It prints rather than asserts, except for the one invariant worth pinning.
--------------------------------------------------------------------------- */

const REG = "0x42EbcD44C2295702130f0A641633c691bA5f9480";
const ONE_MON = 1_000_000_000_000_000_000n;
const MON_USD = 0.024638; // Kuru MON_USDC mid, read this session

/** The six active masters, exactly as the live endpoint returned them. */
const LIVE: ReadonlyArray<{ id: string; name: string; wmon: number }> = [
  { id: "13", name: "Dime Que Si", wmon: 1 },
  { id: "12", name: "Suddenly", wmon: 300 },
  { id: "11", name: "Money Making Machine", wmon: 300 },
  { id: "10", name: "Sloppy", wmon: 35 },
  { id: "9", name: "Killah", wmon: 100 },
  { id: "8", name: "MARINA", wmon: 35 },
  { id: "6", name: "Ganado", wmon: 100 },
];

function catalogue(freeIds: readonly string[] = []): EditionOffer[] {
  return LIVE.map((m) => ({
    collection: REG,
    masterId: m.id,
    kind: "MUSIC" as const,
    tier: "STANDARD" as const,
    terms: freeIds.includes(m.id) ? ("FREE" as const) : ("PURCHASE" as const),
    priceWei: freeIds.includes(m.id)
      ? null
      : BigInt(Math.round(m.wmon)) * ONE_MON,
  }));
}

const ORIGIN = { lat: 17.5506, lng: -99.5006 };
const DRAW = { origin: ORIGIN, minRadiusM: 35, maxRadiusM: 60 };

type Outcome = "bought" | "free" | "skipped_cannot_afford" | "skipped_owned";

/**
 * One hunter, walking. Every minute they collect a 1 MON spawn; every `every`
 * minutes an edition is placed instead. They take anything they can afford.
 */
function walk(
  minutes: number,
  every: number,
  freeIds: readonly string[] = [],
  /** Offer only what they can already pay for. The draw supports this because
      the caller supplies the catalogue; this is the whole point of that. */
  affordableOnly = false,
) {
  let earnedWei = 0n;
  let metresWalked = 0;
  const owned = new Set<string>();
  const outcomes: Record<Outcome, number> = {
    bought: 0,
    free: 0,
    skipped_cannot_afford: 0,
    skipped_owned: 0,
  };
  const firstBuyAt: Record<string, number> = {};

  for (let minute = 1; minute <= minutes; minute += 1) {
    if (minute % every !== 0) {
      earnedWei += ONE_MON; // a spawn
      metresWalked += 48.6; // mean radius of a 35-60m area-uniform annulus
      continue;
    }

    let available = catalogue(freeIds).filter((o) => !owned.has(o.masterId));
    if (affordableOnly) {
      available = available.filter(
        (o) => canAfford(earnedWei, quotedPrice(o)).ok,
      );
      if (available.length === 0) {
        outcomes.skipped_cannot_afford += 1;
        continue;
      }
    }
    if (available.length === 0) {
      outcomes.skipped_owned += 1;
      continue;
    }

    const draw = deriveEdition(`hunter-1:${minute}`, {
      ...DRAW,
      catalogue: available,
    });
    metresWalked += haversineMeters(ORIGIN, { lat: draw.lat, lng: draw.lng });

    const price = quotedPrice(draw.offer);
    const { ok } = canAfford(earnedWei, price);
    if (!ok) {
      outcomes.skipped_cannot_afford += 1;
      continue;
    }
    earnedWei -= price;
    owned.add(draw.offer.masterId);
    outcomes[price === 0n ? "free" : "bought"] += 1;
    firstBuyAt[draw.offer.masterId] ??= minute;
  }

  return { earnedWei, metresWalked, owned, outcomes, firstBuyAt };
}

describe("edition economics, against the live catalogue", () => {
  it("prints what a hunter actually experiences", () => {
    const mon = (w: bigint) => Number(w / 10n ** 15n) / 1000;

    console.log("\n  PRICES vs ONE SPAWN (1 MON)");
    for (const m of LIVE) {
      console.log(
        `    ${m.name.padEnd(22)} ${String(m.wmon).padStart(4)} WMON  ` +
          `= ${String(m.wmon).padStart(4)} spawns  ` +
          `~${((m.wmon * 48.6) / 1000).toFixed(2)} km  ` +
          `~$${(m.wmon * MON_USD).toFixed(2)}`,
      );
    }

    for (const hours of [1, 3, 8]) {
      const r = walk(hours * 60, 10);
      console.log(
        `\n  ${hours}h walking, an edition every 10 min, all PURCHASE`,
      );
      console.log(
        `    earned+spent -> ${mon(r.earnedWei)} MON left, ` +
          `${(r.metresWalked / 1000).toFixed(1)} km walked`,
      );
      console.log(
        `    bought ${r.outcomes.bought}  free ${r.outcomes.free}  ` +
          `skipped(broke) ${r.outcomes.skipped_cannot_afford}  ` +
          `owned ${[...r.owned].length}/6`,
      );
    }

    console.log("\n  SAME WALKS, but only offering what they can afford");
    for (const hours of [1, 3, 8]) {
      const r = walk(hours * 60, 10, [], true);
      const enc =
        r.outcomes.bought + r.outcomes.free + r.outcomes.skipped_cannot_afford;
      const acted = r.outcomes.bought + r.outcomes.free;
      console.log(
        `    ${hours}h -> bought ${r.outcomes.bought}  owned ${r.owned.size}/6  ` +
          `nothing-affordable ${r.outcomes.skipped_cannot_afford}  ` +
          `actionable ${enc === 0 ? 0 : Math.round((acted / enc) * 100)}% of encounters`,
      );
    }

    const withFree = walk(60, 10, ["10", "8"]);
    console.log("\n  1h, with the two cheapest given away FREE");
    console.log(
      `    bought ${withFree.outcomes.bought}  free ${withFree.outcomes.free}  ` +
        `skipped(broke) ${withFree.outcomes.skipped_cannot_afford}  ` +
        `owned ${[...withFree.owned].length}/6`,
    );
    console.log("");
  });

  // The one thing that must hold no matter what the prices are: the rule is
  // one of each per passkey, forever, so a hunter can never be sold the same
  // work twice however long they walk.
  it("never sells the same work twice", () => {
    const r = walk(24 * 60, 5);
    const total = r.outcomes.bought + r.outcomes.free;
    if (total !== r.owned.size) {
      throw new Error(`took ${total} editions but owns ${r.owned.size}`);
    }
    if (r.owned.size > LIVE.length) {
      throw new Error("owns more works than exist");
    }
  });
});
