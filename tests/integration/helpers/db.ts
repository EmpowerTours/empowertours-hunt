import "./env";
import { PrismaClient } from "@prisma/client";

// One client for the whole suite. `fileParallelism: false` in
// vitest.integration.config.ts means only one file runs at a time, so a single
// pool is both sufficient and necessary — several clients against one Postgres
// would exhaust connections long before they proved anything.
export const db = new PrismaClient();

// Every table, child-first. Written out rather than derived from
// information_schema on purpose: a table added to the schema and forgotten here
// SHOULD break a test, because a suite that silently stops cleaning up starts
// passing for the wrong reasons.
const TABLES = [
  "AdminAction",
  "Payout",
  "Spawn",
  "CreditLedger",
  "HintRequest",
  "ClaimAttempt",
  "Find",
  "PlayerHunt",
  "Zone",
  "Cache",
  "StepCompletion",
  "Enrollment",
  "TrackStep",
  "Track",
  "Hunt",
  "AdminUser",
  "Player",
] as const;

/**
 * Empty every table.
 *
 * TRUNCATE ... CASCADE in one statement, so there is no order in which a
 * foreign key can refuse. RESTART IDENTITY matters less here (ids are cuids)
 * but keeps a re-run of the suite indistinguishable from a first run.
 */
export async function resetDatabase(): Promise<void> {
  const list = TABLES.map((t) => `"${t}"`).join(", ");
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
