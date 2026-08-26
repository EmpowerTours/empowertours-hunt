import "./helpers/env";
import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDatabase } from "./helpers/db";
import {
  makeHunt,
  makePlayer,
  makePlayerHunt,
  makeSpawn,
} from "./helpers/factories";
import { routeCtx, signedRequest } from "./helpers/http";
import { issueSession, SESSION_COOKIE } from "@/lib/auth/mera";
import { POST as claim } from "@/app/api/hunt/[huntId]/claim/route";
import { POST as collect } from "@/app/api/hunt/[huntId]/spawn/collect/route";

/* ---------------------------------------------------------------------------
   Lock ordering across the two money routes.

   Both take a row on PlayerHunt and the hunt's single Hunt row. Taken in
   opposite orders they deadlock, and this is the only test that can see it:
   NEITHER ROUTE DEADLOCKS AGAINST ITSELF at any volume, so reading either one
   alone — or load-testing either one alone — finds nothing.

   Measured before the fix, interleaving claims and collects on one hunt:

     240 requests   1 deadlock,   0 claim 500s
     640 requests  11 deadlocks,  1 claim 500
     640 requests   9 deadlocks,  5 claim 500s
     640 requests   3 deadlocks,  2 claim 500s

   ~0.7% of claims died as HTTP 500 with no audit row, whenever Postgres chose
   the claim as its victim. The collect side never 500d only because its retry
   already listed 40P01.

   The fix is the ordering, not the retry: both routes now take PlayerHunt
   before Hunt. Hunt LAST is the cheaper of the two consistent orders — it is
   the row every claim and every collect in the hunt must touch, so holding it
   briefly matters. Measured after: 0 deadlocks over 1280 requests, and the
   probe runs ~20% FASTER than it did before the fix.

   Deadlocks are counted from pg_stat_database, which is Postgres' own counter
   — not inferred from error strings that a retry might have swallowed.
--------------------------------------------------------------------------- */

const AT = { lat: 21.017_9, lng: -101.256_1 };
const CREDIT = 1_000_000_000_000_000_000n;
const DROP = 10_000_000_000_000_000n;

type Out = { kind: string; status: number; body: Record<string, unknown> };

async function postClaim(
  huntId: string,
  actor: Awaited<ReturnType<typeof makePlayer>>,
  ip: string,
): Promise<Out> {
  const req = new Request("http://localhost/api/hunt/x/claim", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE}=${issueSession(actor.address)}`,
      "x-forwarded-for": ip,
    },
    body: JSON.stringify({
      lat: AT.lat,
      lng: AT.lng,
      accuracyM: 8,
      clientTs: new Date().toISOString(),
    }),
  });
  const res = await claim(req, routeCtx({ huntId }));
  return {
    kind: "claim",
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

async function postCollect(
  huntId: string,
  actor: Awaited<ReturnType<typeof makePlayer>>,
  spawnId: string,
  ip: string,
): Promise<Out> {
  const req = await signedRequest({
    url: "http://localhost/api/hunt/x/spawn/collect",
    actor,
    huntId,
    lat: AT.lat,
    lng: AT.lng,
    accuracyM: 8,
    body: { spawnId },
    ip,
  });
  const res = await collect(req, routeCtx({ huntId }));
  return {
    kind: "collect",
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

async function deadlockCount(): Promise<number> {
  const rows = await db.$queryRaw<{ deadlocks: bigint }[]>`
    SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`;
  return Number(rows[0].deadlocks);
}

describe("claim and collect take their shared rows in the same order", () => {
  beforeEach(resetDatabase);

  it(
    "interleaves claims and collects on one hunt without deadlocking",
    async () => {
      const before = await deadlockCount();
      const hunt = await makeHunt({
        budgetCreditWei: "0",
        budgetMonWei: (DROP * 1000n).toString(),
        spawnDailyCapWeiPerPlayer: (DROP * 1000n).toString(),
      } as never);

      const all: Out[] = [];
      // THIRTY ROUNDS, NOT FIFTEEN, AND THE NUMBER IS MEASURED. A deadlock is
      // probabilistic: at fifteen rounds this test caught a reintroduced
      // ordering bug only about half the time, which is worse than useless
      // because a green run would read as proof. At thirty it caught it 3/3,
      // with 2-5 deadlocks each time. The fixed code stays at exactly 0 over
      // 1280 requests, so raising the volume costs no flakiness in the
      // direction that matters. Do not lower it.
      for (let round = 0; round < 30; round++) {
        const actors = await Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            makePlayer(9000 + round * 50 + i),
          ),
        );
        const spawns = await Promise.all(
          actors.map(async (a) => {
            await makePlayerHunt(hunt.id, a.player.id);
            await db.cache.create({
              data: {
                huntId: hunt.id,
                lat: AT.lat,
                lng: AT.lng,
                radiusMeters: 40,
                rewardCreditWei: CREDIT.toString(),
              },
            });
            return makeSpawn({
              hunt,
              player: a.player,
              at: AT,
              amountMonWei: DROP.toString(),
            });
          }),
        );

        // Fired together and alternating, so both routes are always in flight
        // at once. Fresh players each round keeps the rate limiter out of it —
        // a request the limiter refused would never reach a lock at all, and
        // the test would pass by never running the code it is about.
        all.push(
          ...(await Promise.all(
            actors.flatMap((a, i) => [
              postClaim(hunt.id, a, `10.30.${round}.${i}`),
              postCollect(hunt.id, a, spawns[i].id, `10.31.${round}.${i}`),
            ]),
          )),
        );
      }

      // THE ASSERTION. Postgres' own counter, so a retry cannot hide it.
      expect((await deadlockCount()) - before).toBe(0);

      // And nothing opaque reached a player. Every request got an answer it
      // could act on.
      expect(all.filter((r) => r.status !== 200)).toEqual([]);
      expect(all.filter((r) => r.body.error !== undefined)).toEqual([]);

      // Every claim landed. Claims have no ceiling configured here, so any
      // refusal would mean contention beat them.
      const claims = all.filter((r) => r.kind === "claim");
      expect(claims.filter((r) => r.body.found === true)).toHaveLength(
        claims.length,
      );

      // Every attempt is in the audit trail, whatever happened to it.
      expect(await db.claimAttempt.count()).toBe(all.length);
    },
    60_000,
  );
});
