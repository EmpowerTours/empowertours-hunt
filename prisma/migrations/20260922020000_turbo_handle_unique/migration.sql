-- One builder identity, one wallet.
--
-- `turboUsername` had a plain index and no constraint, and nothing could write
-- it anyway: lib/auth/signIn.ts sends "" at registration and no other route
-- sets it, so every row is NULL today. That makes this safe to add without a
-- backfill or a dedupe -- but check rather than assume, because the constraint
-- is the whole point.
--
-- Handles are stored LOWERCASED (lib/hunt/turboHandle.ts). Prisma cannot
-- express a functional lower() unique index, so the stored form is the
-- comparison form; without that, "Foo" and "foo" would be two rows and one
-- person, which is exactly the collision this prevents.
DO $$
DECLARE
  dupes INTEGER;
BEGIN
  SELECT count(*) INTO dupes FROM (
    SELECT lower("turboUsername")
    FROM "Player"
    WHERE "turboUsername" IS NOT NULL
    GROUP BY lower("turboUsername")
    HAVING count(*) > 1
  ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION 'turboUsername has % case-insensitive duplicate(s); resolve before adding the unique constraint', dupes;
  END IF;
END $$;

-- Existing rows predate the lowercasing rule. None exist today, but fold any
-- that appear between writing and running this, so the constraint matches what
-- the application will compare on.
UPDATE "Player"
   SET "turboUsername" = lower("turboUsername")
 WHERE "turboUsername" IS NOT NULL
   AND "turboUsername" <> lower("turboUsername");

CREATE UNIQUE INDEX "Player_turboUsername_key" ON "Player"("turboUsername");
