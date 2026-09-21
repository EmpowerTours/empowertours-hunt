// Placing an edition, atomically.
//
// Separate from lib/hunt/edition.ts because that module is deliberately pure —
// no DB, no network, no clock — so that a dispute is answered by replaying
// stored rows. This is the one statement that writes, and it lives on its own
// so the route and the test run the SAME SQL rather than two copies of it.
//
// ## Why a conditional INSERT and not a create()
//
// The eligibility checks in the route are a read-then-write, which AGENTS.md
// rule 4 calls a bug even when it looks correct, and this one is not even
// theoretical. HuntScreen polls on `scanTick`, and a completed check-in bumps
// that tick immediately ("scan NOW rather than at the next 30s tick"). The
// effect's cleanup aborts the in-flight fetch — but an abort cancels only the
// CLIENT's half; the server request had already run. Two requests therefore
// evaluate the same empty table and both insert.
//
// Observed on the live hunt on 2026-09-21: two Edition rows at 16:22:43.006
// and 16:22:43.007 for one player, one taken and one left hanging. From the
// street that is "the NFT loads up way too quickly".
//
// The WHERE NOT EXISTS re-states both gates inside the statement — a live
// card, and the cooldown — and the affected-row count is what the caller
// believes, never its own earlier read.

import type { Prisma, PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";

export interface PlaceEditionParams {
  huntId: string;
  playerId: string;
  collection: string;
  masterId: string;
  kind: "MUSIC" | "ART";
  tier: "STANDARD" | "COLLECTOR";
  terms: "FREE" | "PURCHASE";
  /** WMON wei. Ignored when terms is FREE, which stores NULL. */
  priceWei: bigint;
  now: Date;
  expiresAt: Date;
  /** Rows created after this instant block a new one. */
  cooldownCutoff: Date;
}

export interface PlacedEdition {
  id: string;
  collection: string;
  masterId: string;
  kind: string;
  tier: string;
  terms: string;
  priceWei: string | null;
  expiresAt: Date;
}

/**
 * Insert one Edition, or nothing at all.
 *
 * Returns the row it wrote, or null when another request got there first —
 * which the caller answers by re-reading the live card, never by creating a
 * second one.
 *
 * The id is generated here rather than left to `@default(cuid())` because a
 * raw INSERT does not go through Prisma's default layer. 32 hex characters of
 * `randomBytes` is the same shape of guarantee a cuid gives and does not need
 * a second round trip to find out what was written.
 */
export async function placeEdition(
  db: PrismaClient | Prisma.TransactionClient,
  p: PlaceEditionParams,
): Promise<PlacedEdition | null> {
  const id = `edn${randomBytes(16).toString("hex")}`;
  const priceWei = p.terms === "FREE" ? null : p.priceWei.toString();

  const inserted = await db.$executeRaw`
    INSERT INTO "Edition" (
      "id","huntId","playerId","collection","masterId",
      "kind","tier","terms","priceWei","expiresAt","createdAt"
    )
    SELECT ${id}, ${p.huntId}, ${p.playerId},
           ${p.collection}, ${p.masterId},
           ${p.kind}::"EditionKind",
           ${p.tier}::"EditionTier",
           ${p.terms}::"EditionTerms",
           ${priceWei}::numeric,
           ${p.expiresAt}, ${p.now}
    WHERE NOT EXISTS (
      SELECT 1 FROM "Edition" e
      WHERE e."huntId" = ${p.huntId}
        AND e."playerId" = ${p.playerId}
        AND (
              -- A card they have not answered and that has not timed out.
              (e."takenAt" IS NULL AND e."dismissedAt" IS NULL
               AND e."expiresAt" > ${p.now})
              -- Or one placed inside the cooldown, however it ended.
           OR e."createdAt" > ${p.cooldownCutoff}
        )
    )
  `;

  // Reject by default (AGENTS.md rule 2): anything that is not exactly one
  // row written is treated as "somebody else won", never as success.
  if (inserted !== 1) return null;

  return {
    id,
    collection: p.collection,
    masterId: p.masterId,
    kind: p.kind,
    tier: p.tier,
    terms: p.terms,
    priceWei,
    expiresAt: p.expiresAt,
  };
}
