import "./helpers/env";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { db } from "./helpers/db";
import { toWei } from "@/lib/wei";

/* ---------------------------------------------------------------------------
   The schema as the database actually built it.

   Everything here is invisible to a unit test by construction: it is about the
   migration, the column types Postgres ended up with, and what those columns
   refuse. `prisma generate` produces the same TypeScript client whether the
   wei columns are numeric(78,0) or double precision, so nothing in the 370
   pure-function tests would notice the difference.
--------------------------------------------------------------------------- */

describe("migrations and schema", () => {
  // `migrate diff --from-migrations` replays the migration folder into a
  // scratch database to see what it builds. Prisma will not create that
  // database itself when the role lacks CREATEDB, so it is made here and the
  // name is derived from DATABASE_URL — never a fixed name that could collide
  // with something real.
  const shadowUrl = `${process.env.DATABASE_URL}_shadow_drift`;
  const shadowName = new URL(shadowUrl).pathname.slice(1);

  beforeAll(async () => {
    await db.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${shadowName}"`);
    await db.$executeRawUnsafe(`CREATE DATABASE "${shadowName}"`);
  });

  afterAll(async () => {
    await db.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${shadowName}"`);
  });

  it("has no drift between prisma/migrations and schema.prisma", () => {
    // The failure this catches: someone edits schema.prisma, runs `prisma db
    // push` locally, and never generates a migration. Their machine works, the
    // deployment does not, and the difference only appears at `migrate deploy`
    // on Railway — which is to say, in front of the operator.
    const diff = execFileSync(
      "npx",
      [
        "prisma",
        "migrate",
        "diff",
        "--from-migrations",
        "prisma/migrations",
        "--to-schema-datamodel",
        "prisma/schema.prisma",
        "--shadow-database-url",
        shadowUrl,
        "--script",
      ],
      { encoding: "utf8" },
    );

    // Prisma emits a comment when there is nothing to do; any real statement
    // means the two have parted company.
    const statements = diff
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("--"));

    expect(statements).toEqual([]);
  });

  it("stores every wei column as numeric(78,0)", async () => {
    // Scale 0 is the load-bearing half. It is what makes the DATABASE reject
    // "0.5" rather than rounding it, so a fractional wei cannot enter through
    // any path — including one written years from now by someone who never
    // read lib/wei.ts.
    const columns = await db.$queryRaw<
      { table_name: string; column_name: string; numeric_precision: number | null; numeric_scale: number | null; data_type: string }[]
    >`
      SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (column_name LIKE '%Wei' OR column_name LIKE '%wei')
       ORDER BY table_name, column_name`;

    expect(columns.length).toBeGreaterThan(0);

    for (const c of columns) {
      expect(
        `${c.table_name}.${c.column_name} ${c.data_type}(${c.numeric_precision},${c.numeric_scale})`,
      ).toBe(`${c.table_name}.${c.column_name} numeric(78,0)`);
    }
  });
});

describe("what a wei column actually does", () => {
  let huntId: string;

  beforeAll(async () => {
    const hunt = await db.hunt.create({ data: { name: "wei probe" } });
    huntId = hunt.id;
  });

  async function write(value: string): Promise<void> {
    await db.$executeRawUnsafe(
      `UPDATE "Hunt" SET "budgetMonWei" = $1::numeric WHERE "id" = $2`,
      value,
      huntId,
    );
  }

  async function read(): Promise<string> {
    const hunt = await db.hunt.findUniqueOrThrow({ where: { id: huntId } });
    return hunt.budgetMonWei.toFixed(0);
  }

  // -------------------------------------------------------------------------
  // THE COLUMN TYPE IS NOT THE GUARD. README.md claimed "scale 0 means the
  // database itself rejects "0.5", "1e18" and "0x10"". Measured against
  // Postgres 16, it rejects none of them — it COERCES all three, silently:
  //
  //     '0.5'::numeric(78,0)  -> 1                     (rounds, not rejects)
  //     '1e18'::numeric(78,0) -> 1000000000000000000   (a whole MON)
  //     '0x10'::numeric(78,0) -> 16                    (hex literals, PG 16)
  //     '-1'::numeric(78,0)   -> -1                    (sign is allowed)
  //
  // Scale 0 controls ROUNDING, not admission. These tests assert what the
  // database really does so that nobody reads the old sentence and writes a
  // raw-SQL path trusting a guard that was never there.
  //
  // lib/wei.ts IS the guard, and the last case below is what makes that
  // load-bearing rather than incidental.
  // -------------------------------------------------------------------------
  it.each([
    ["0.5", "1"],
    ["0.4", "0"],
    ["1e18", "1000000000000000000"],
    ["0x10", "16"],
    ["-1", "-1"],
    [" 1 ", "1"],
  ])("silently coerces %j to %s rather than rejecting it", async (bad, got) => {
    await write(bad);
    expect(await read()).toBe(got);
  });

  it("accepts a NEGATIVE amount, which no CHECK constraint forbids", async () => {
    // Worth stating on its own because of what a negative amount would do to
    // CEILING 2 in the collect route:
    //
    //   WHERE "spentMonWei" + amount <= "budgetMonWei"
    //
    // A negative amount passes that unconditionally AND decreases spentMonWei,
    // so it un-spends the hunt budget — an unbounded spend dressed as a
    // refund. Nothing in the schema stops it; `toWei` refusing a negative on
    // every write path is the entire defence.
    const constraints = await db.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS count
        FROM information_schema.check_constraints c
        JOIN information_schema.constraint_column_usage u
          ON u.constraint_name = c.constraint_name
       WHERE u.table_schema = 'public'
         AND u.column_name LIKE '%Wei'
         AND c.check_clause NOT LIKE '%IS NOT NULL%'`;

    expect(Number(constraints[0].count)).toBe(0);
  });

  it("is guarded by lib/wei.ts, which rejects every value above", () => {
    // The pure-function suite already tests toWei in isolation. The point here
    // is the JOIN: these exact strings reach the database unchanged if this
    // function is ever bypassed, and the database will take them.
    for (const bad of ["0.5", "0.4", "1e18", "0x10", "-1", " 1 ", ""]) {
      expect(() => toWei(bad)).toThrow();
    }
  });

  it("round-trips a 78-digit value with no loss", async () => {
    // 78 nines. A double carries ~15-16 significant digits, so if any layer
    // between here and the disk were a float this comes back rounded — and a
    // rounded wei is a wrong amount of money, silently.
    const huge = "9".repeat(78);
    await write(huge);

    expect(await read()).toBe(huge);
    expect(BigInt(await read())).toBe(BigInt(huge));
  });

  it("refuses a 79th digit rather than truncating it", async () => {
    // The one thing the column type genuinely does enforce.
    await expect(write("1".repeat(79))).rejects.toThrow();
  });

  it("refuses text that is not a number at all", async () => {
    await expect(write("not a number")).rejects.toThrow();
  });
});
