import "./helpers/env";
import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDatabase } from "./helpers/db";
import { makeHunt, makePlayer } from "./helpers/factories";
import { placeEdition } from "@/lib/hunt/edition-place";

/* ---------------------------------------------------------------------------
   One card, however many requests arrive together.

   This is the only test that can see the bug. A single request places exactly
   one edition at any volume, so reading the route — or hammering it serially —
   finds nothing. It takes two requests evaluating the same empty table.

   That is not hypothetical. HuntScreen polls this endpoint on `scanTick`, and
   a completed check-in bumps that tick immediately ("scan NOW rather than at
   the next 30s tick"). The effect's cleanup aborts the in-flight fetch, but an
   abort cancels only the CLIENT's half — the server request had already run.

   Measured on the live hunt on 2026-09-21: two Edition rows for one player at
   16:22:43.006 and 16:22:43.007. One was taken, the other left hanging, and
   the hunter saw two full-screen buy cards in a row.
--------------------------------------------------------------------------- */

const COLLECTION = "0x1111111111111111111111111111111111111111";
const PRICE = 35n * 10n ** 18n;

async function seed() {
  const hunt = await makeHunt({ editionsEnabled: true });
  const { player } = await makePlayer(1);
  return { huntId: hunt.id, playerId: player.id, hunt };
}

function params(
  huntId: string,
  playerId: string,
  over: Partial<Parameters<typeof placeEdition>[1]> = {},
) {
  const now = new Date();
  return {
    huntId,
    playerId,
    collection: COLLECTION,
    masterId: "8",
    kind: "MUSIC" as const,
    tier: "STANDARD" as const,
    terms: "PURCHASE" as const,
    priceWei: PRICE,
    now,
    expiresAt: new Date(now.getTime() + 300_000),
    cooldownCutoff: new Date(now.getTime() - 600_000),
    ...over,
  };
}

describe("placeEdition", () => {
  beforeEach(resetDatabase);

  it("writes the row it says it wrote", async () => {
    const { huntId, playerId } = await seed();
    const placed = await placeEdition(db, params(huntId, playerId));
    expect(placed).not.toBeNull();

    const row = await db.edition.findUniqueOrThrow({
      where: { id: placed!.id },
    });
    expect(row.masterId).toBe("8");
    expect(row.tier).toBe("STANDARD");
    expect(row.terms).toBe("PURCHASE");
    // Decimal(78,0), never a float: the raw INSERT casts to numeric and this
    // is what proves the cast round-trips.
    expect(row.priceWei?.toFixed(0)).toBe(PRICE.toString());
  });

  it("stores NULL for a FREE offer", async () => {
    const { huntId, playerId } = await seed();
    const placed = await placeEdition(
      db,
      params(huntId, playerId, { terms: "FREE" }),
    );
    const row = await db.edition.findUniqueOrThrow({
      where: { id: placed!.id },
    });
    expect(row.priceWei).toBeNull();
  });

  // THE POINT OF THIS FILE.
  it("places exactly one card when eight requests arrive at once", async () => {
    const { huntId, playerId } = await seed();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        placeEdition(db, params(huntId, playerId)),
      ),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(await db.edition.count({ where: { playerId } })).toBe(1);
  });

  it("refuses while a live card is unanswered, even past the cooldown", async () => {
    const { huntId, playerId } = await seed();
    const first = await placeEdition(db, params(huntId, playerId));
    expect(first).not.toBeNull();

    // Cooldown waived entirely, so the live card is the only thing left in
    // the way. One minute on, not ten: the TTL is five minutes, and a card
    // that has expired would prove nothing about this clause.
    const later = new Date(Date.now() + 60_000);
    const second = await placeEdition(
      db,
      params(huntId, playerId, {
        now: later,
        cooldownCutoff: new Date(later.getTime() - 1),
        expiresAt: new Date(later.getTime() + 300_000),
      }),
    );
    expect(second).toBeNull();
  });

  // A dismissal answers the card. It must stop blocking, and the COOLDOWN
  // must then be the only thing holding the next one back — declining is not
  // a way to re-roll immediately.
  it("still refuses inside the cooldown after a dismissal", async () => {
    const { huntId, playerId } = await seed();
    const first = await placeEdition(db, params(huntId, playerId));
    await db.edition.update({
      where: { id: first!.id },
      data: { dismissedAt: new Date() },
    });

    const now = new Date();
    expect(
      await placeEdition(
        db,
        params(huntId, playerId, {
          now,
          cooldownCutoff: new Date(now.getTime() - 600_000),
        }),
      ),
    ).toBeNull();
  });

  it("allows a new card once the cooldown has passed and the last was answered", async () => {
    const { huntId, playerId } = await seed();
    const first = await placeEdition(db, params(huntId, playerId));
    await db.edition.update({
      where: { id: first!.id },
      data: { dismissedAt: new Date() },
    });

    const later = new Date(Date.now() + 11 * 60_000);
    const second = await placeEdition(
      db,
      params(huntId, playerId, {
        now: later,
        cooldownCutoff: new Date(later.getTime() - 600_000),
        expiresAt: new Date(later.getTime() + 300_000),
      }),
    );
    expect(second).not.toBeNull();
    expect(await db.edition.count({ where: { playerId } })).toBe(2);
  });

  // The gate is per player. One busy hunter must not starve another.
  it("does not let one player's card block another's", async () => {
    const { huntId, playerId } = await seed();
    const { player: other } = await makePlayer(2);
    expect(await placeEdition(db, params(huntId, playerId))).not.toBeNull();
    expect(await placeEdition(db, params(huntId, other.id))).not.toBeNull();
  });
});
