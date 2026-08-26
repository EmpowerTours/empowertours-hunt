import "./helpers/env";
import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDatabase } from "./helpers/db";
import {
  makeHunt,
  makePlayer,
  makePlayerHunt,
  makeSpawn,
} from "./helpers/factories";
import { signedRequest, routeCtx } from "./helpers/http";
import { POST as collect } from "@/app/api/hunt/[huntId]/spawn/collect/route";

/* ---------------------------------------------------------------------------
   The ceilings, under genuine concurrency.

   This is the file the pure-function suite cannot substitute for. Every ceiling
   in the collect route is a conditional UPDATE whose affected-row count decides
   the outcome:

       UPDATE "Hunt" SET "spentMonWei" = "spentMonWei" + :amount
        WHERE "spentMonWei" + :amount <= "budgetMonWei"

   Whether that holds is a property of Postgres under contention, not of any
   function. A unit test can only assert that the string was assembled; the row
   lock, the isolation level and the serialization failure are the actual
   subject, and they only exist against a real database.

   The route is called directly, with a real session cookie and a real EIP-712
   signature, so its auth, its rate limiter and its nonce store all run. Tests
   that stubbed those would prove the ceilings hold for requests that could
   never arrive.

   ON RATE LIMITS: the spawn limiter allows 6 per player and 20 per IP in 60s.
   Concurrency here stays inside that, and separate actors get separate
   `x-forwarded-for` buckets — otherwise a request refused by the limiter would
   look exactly like a ceiling holding, and the test would pass for the wrong
   reason. The assertions below check the reason, never just the count.
--------------------------------------------------------------------------- */

const AT = { lat: 21.017_9, lng: -101.256_1 };
const ONE_MON = 1_000_000_000_000_000_000n;

interface CollectOutcome {
  status: number;
  body: Record<string, unknown>;
}

async function post(args: {
  huntId: string;
  actor: Awaited<ReturnType<typeof makePlayer>>;
  spawnId: string;
  ip: string;
}): Promise<CollectOutcome> {
  const req = await signedRequest({
    url: "http://localhost/api/hunt/x/spawn/collect",
    actor: args.actor,
    huntId: args.huntId,
    lat: AT.lat,
    lng: AT.lng,
    accuracyM: 8,
    body: { spawnId: args.spawnId },
    ip: args.ip,
  });
  const res = await collect(req, routeCtx({ huntId: args.huntId }));
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

/* Measured while writing these: deleting `AND "collectedAt" IS NULL` from
   CEILING 1 leaves this whole describe block GREEN, because `Payout.spawnId
   @unique` catches the loser as a P2002 and the route files it as
   "spawn_already_collected". Two independent mechanisms hold the same
   invariant, and these tests assert the INVARIANT — one spawn, one payout —
   not either mechanism. Which is the right thing to assert, but it means a
   refactor may remove one layer without any test objecting. Removing both is
   what these would catch. Do not read a green run as "the conditional UPDATE
   is still doing something". */
describe("CEILING 1 — one spawn, one collector", () => {
  beforeEach(resetDatabase);

  it("pays exactly once when the same spawn is collected concurrently", async () => {
    const hunt = await makeHunt({
      autoApproveMaxWei: ONE_MON.toString(),
    } as never);
    const actor = await makePlayer(1);
    await makePlayerHunt(hunt.id, actor.player.id);
    const spawn = await makeSpawn({
      hunt,
      player: actor.player,
      at: AT,
      amountMonWei: (ONE_MON / 1000n).toString(),
    });

    // Five, not fifty: the per-player limiter allows six in the window, and a
    // request the limiter refused would be indistinguishable from the ceiling
    // holding. Any count above one is enough to prove a race exists.
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        post({ huntId: hunt.id, actor, spawnId: spawn.id, ip: `10.0.0.${i}` }),
      ),
    );

    // Nothing was refused for a reason unrelated to the race.
    expect(results.filter((r) => r.status === 429)).toEqual([]);

    const accepted = results.filter((r) => r.body.collected === true);
    expect(accepted).toHaveLength(1);

    // The invariant that actually matters: one debt, not one HTTP 200.
    const payouts = await db.payout.findMany({ where: { spawnId: spawn.id } });
    expect(payouts).toHaveLength(1);

    const after = await db.hunt.findUniqueOrThrow({ where: { id: hunt.id } });
    expect(after.spentMonWei.toFixed(0)).toBe((ONE_MON / 1000n).toString());
  });

  it("writes the seed reveal exactly once, with the winning collect", async () => {
    const hunt = await makeHunt();
    const actor = await makePlayer(2);
    await makePlayerHunt(hunt.id, actor.player.id);
    const spawn = await makeSpawn({
      hunt,
      player: actor.player,
      at: AT,
      amountMonWei: "1000000000000000",
    });

    await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        post({ huntId: hunt.id, actor, spawnId: spawn.id, ip: `10.1.0.${i}` }),
      ),
    );

    const after = await db.spawn.findUniqueOrThrow({ where: { id: spawn.id } });
    expect(after.collectedAt).not.toBeNull();
    // The commitment must open. A reveal that does not is the difference
    // between a verifiable draw and a promise.
    expect(after.seedReveal).toBeTypeOf("string");
  });
});

describe("CEILING 2 — the hunt MON budget", () => {
  beforeEach(resetDatabase);

  it("never lets concurrent collects spend past the budget", async () => {
    // Budget for three drops; ten players each holding one. Under a
    // read-then-write all ten observe spent=0 and all ten pass, and the hunt
    // overspends by seven drops.
    const drop = ONE_MON / 100n;
    const hunt = await makeHunt({
      budgetMonWei: (drop * 3n).toString(),
      spawnDailyCapWeiPerPlayer: ONE_MON.toString(),
    } as never);

    const actors = await Promise.all(
      Array.from({ length: 10 }, (_, i) => makePlayer(100 + i)),
    );
    const spawns = await Promise.all(
      actors.map(async (a) => {
        await makePlayerHunt(hunt.id, a.player.id);
        return makeSpawn({
          hunt,
          player: a.player,
          at: AT,
          amountMonWei: drop.toString(),
        });
      }),
    );

    const results = await Promise.all(
      actors.map((actor, i) =>
        post({
          huntId: hunt.id,
          actor,
          spawnId: spawns[i].id,
          ip: `10.2.0.${i}`,
        }),
      ),
    );

    expect(results.filter((r) => r.status === 429)).toEqual([]);

    const accepted = results.filter((r) => r.body.collected === true);

    // THE INVARIANT. Not "exactly three succeeded" — under Serializable some
    // of these abort and never reach the ceiling at all (see the test below).
    // What must hold, at any level of contention, is that the hunt never spends
    // past its budget and never issues a payout it did not fund.
    //
    // Honest limit: because Serializable aborts most of these before they reach
    // the ceiling, deleting the budget comparison from the WHERE clause leaves
    // THIS test green — the overspend never gets a chance to happen. Its
    // sequential sibling below is the one that pins the ceiling itself, and it
    // does fail when the comparison is removed. Both are needed.
    const after = await db.hunt.findUniqueOrThrow({ where: { id: hunt.id } });
    const spent = BigInt(after.spentMonWei.toFixed(0));

    expect(spent).toBeLessThanOrEqual(BigInt(after.budgetMonWei.toFixed(0)));
    expect(spent).toBe(drop * BigInt(accepted.length));
    expect(accepted.length).toBeGreaterThan(0);
    expect(accepted.length).toBeLessThanOrEqual(3);

    // Every accepted collect left exactly one debt, and every refused one left
    // none. A spawn that was not paid for must still be open, not burned.
    expect(await db.payout.count()).toBe(accepted.length);
    expect(await db.spawn.count({ where: { collectedAt: null } })).toBe(
      10 - accepted.length,
    );
  });

  it("refuses the eleventh drop once the budget is spent", async () => {
    // The ceiling on its own, without contention muddying it: three drops fit,
    // the fourth does not, and the refusal names the reason.
    const drop = ONE_MON / 100n;
    const hunt = await makeHunt({
      budgetMonWei: (drop * 3n).toString(),
      spawnDailyCapWeiPerPlayer: ONE_MON.toString(),
    } as never);

    const outcomes: string[] = [];
    for (let i = 0; i < 4; i++) {
      const actor = await makePlayer(150 + i);
      await makePlayerHunt(hunt.id, actor.player.id);
      const spawn = await makeSpawn({
        hunt,
        player: actor.player,
        at: AT,
        amountMonWei: drop.toString(),
      });
      const res = await post({
        huntId: hunt.id,
        actor,
        spawnId: spawn.id,
        ip: `10.7.0.${i}`,
      });
      outcomes.push(
        res.body.collected === true ? "collected" : String(res.body.reason),
      );
    }

    expect(outcomes).toEqual([
      "collected",
      "collected",
      "collected",
      "hunt_budget_exhausted",
    ]);

    const after = await db.hunt.findUniqueOrThrow({ where: { id: hunt.id } });
    expect(BigInt(after.spentMonWei.toFixed(0))).toBe(drop * 3n);
  });

  // ---------------------------------------------------------------------
  // WAS A KNOWN GAP, NOW FIXED. Kept as the regression test.
  //
  // The commit runs Serializable because the auto-approval daily cap is a SUM
  // over rows the transaction is itself inserting. That converts a concurrent
  // overshoot into an abort — correct — but nothing used to HANDLE the abort.
  // Postgres raised 40001, Prisma surfaced it as P2010 with meta.code
  // "40001", and the route's catch knew only CollectRejected and P2002, so it
  // rethrew: HTTP 500 "internal error" to a player standing at the spawn, and
  // no ClaimAttempt row, so the trail a payout dispute is answered from was
  // missing exactly the events that happened under load.
  //
  // Measured before the fix: at ten concurrent collects, SEVEN came back 500.
  //
  // lib/db/retry.ts now retries the whole transaction — safe precisely because
  // an aborted transaction committed nothing — and files "contended" when it
  // gives up. These assertions are what stop that regressing.
  // ---------------------------------------------------------------------
  it("answers every contended collect instead of throwing a 500", async () => {
    const drop = ONE_MON / 100n;
    const hunt = await makeHunt({
      budgetMonWei: (drop * 20n).toString(),
      spawnDailyCapWeiPerPlayer: ONE_MON.toString(),
    } as never);

    const actors = await Promise.all(
      Array.from({ length: 10 }, (_, i) => makePlayer(600 + i)),
    );
    const spawns = await Promise.all(
      actors.map(async (a) => {
        await makePlayerHunt(hunt.id, a.player.id);
        return makeSpawn({
          hunt,
          player: a.player,
          at: AT,
          amountMonWei: drop.toString(),
        });
      }),
    );

    const results = await Promise.all(
      actors.map((actor, i) =>
        post({
          huntId: hunt.id,
          actor,
          spawnId: spawns[i].id,
          ip: `10.8.0.${i}`,
        }),
      ),
    );

    // THE FIX. Not one opaque failure: every request gets an answer it can act
    // on, whether that is a payout or "try again".
    expect(results.filter((r) => r.status === 500)).toEqual([]);
    expect(results.every((r) => r.status === 200)).toBe(true);

    const collected = results.filter((r) => r.body.collected === true);
    const contended = results.filter((r) => r.body.reason === "contended");

    // Budget is ample and every player has their own spawn, so nothing here
    // can be refused on a ceiling. Every outcome is a collect or a retry-me.
    expect(collected.length + contended.length).toBe(results.length);

    // Retrying should make ALL of these land at the configured six attempts —
    // measured 10/10 across repeated runs. Asserted as a floor rather than an
    // equality because it is a timing property of a real database, and a flaky
    // test that has to be re-run teaches people to ignore it. If this ever
    // falls back toward the three that landed with no retry at all, the retry
    // has stopped working even though no 500 appears.
    expect(collected.length).toBeGreaterThanOrEqual(8);

    // EVERY attempt is now in the audit trail, contended ones included. This is
    // the half that was silently missing: a dispute about a collect that
    // happened under load had nothing to replay.
    const attempts = await db.claimAttempt.findMany();
    expect(attempts).toHaveLength(results.length);
    expect(attempts.filter((a) => a.accepted)).toHaveLength(collected.length);
    for (const a of attempts.filter((x) => !x.accepted)) {
      expect(a.reason).toBe("contended");
      expect(a.detail).toMatch(/serialization failed after \d+ attempts/);
    }

    // And a contended collect cost nothing: no payout, and the spawn is still
    // there to be tapped again. Transient, not a loss.
    expect(await db.payout.count()).toBe(collected.length);
    expect(await db.spawn.count({ where: { collectedAt: null } })).toBe(
      contended.length,
    );

    const after = await db.hunt.findUniqueOrThrow({ where: { id: hunt.id } });
    expect(BigInt(after.spentMonWei.toFixed(0))).toBe(
      drop * BigInt(collected.length),
    );
  });

  it("pays nothing at all when the budget is unconfigured", async () => {
    // budgetMonWei = 0 is NOT "no ceiling" on the MON path — this is real money
    // leaving a hot wallet, so an unconfigured hunt must pay nothing. (Credit
    // reads 0 as disabled; the asymmetry is deliberate and easy to "tidy" away.)
    const hunt = await makeHunt({ budgetMonWei: "0" } as never);
    const actor = await makePlayer(200);
    await makePlayerHunt(hunt.id, actor.player.id);
    const spawn = await makeSpawn({
      hunt,
      player: actor.player,
      at: AT,
      amountMonWei: "1000000000000000",
    });

    const res = await post({
      huntId: hunt.id,
      actor,
      spawnId: spawn.id,
      ip: "10.3.0.1",
    });

    expect(res.body.collected).toBe(false);
    expect(res.body.reason).toBe("hunt_budget_exhausted");
    expect(await db.payout.count()).toBe(0);
  });
});

describe("CEILING 3 — the per-player rolling 24h cap", () => {
  beforeEach(resetDatabase);

  it("stops one player collecting past their daily cap", async () => {
    const drop = ONE_MON / 100n;
    const hunt = await makeHunt({
      budgetMonWei: ONE_MON.toString(),
      // Two drops' worth. The third must be refused.
      spawnDailyCapWeiPerPlayer: (drop * 2n).toString(),
      cooldownSeconds: 0,
    } as never);

    const actor = await makePlayer(300);
    await makePlayerHunt(hunt.id, actor.player.id);

    const outcomes: string[] = [];
    // Sequential, not concurrent: this cap is a SUM over rows the transaction
    // is itself inserting, so the interesting case is the fourth collect
    // seeing the first three. Concurrency is covered by CEILING 2 above.
    for (let i = 0; i < 4; i++) {
      const spawn = await makeSpawn({
        hunt,
        player: actor.player,
        at: AT,
        amountMonWei: drop.toString(),
      });
      const res = await post({
        huntId: hunt.id,
        actor,
        spawnId: spawn.id,
        ip: `10.4.0.${i}`,
      });
      outcomes.push(
        res.body.collected === true ? "collected" : String(res.body.reason),
      );
    }

    expect(outcomes.slice(0, 2)).toEqual(["collected", "collected"]);
    expect(outcomes.slice(2)).toEqual([
      "player_daily_cap_reached",
      "player_daily_cap_reached",
    ]);

    const stats = await db.playerHunt.findFirstOrThrow({
      where: { huntId: hunt.id, playerId: actor.player.id },
    });
    expect(BigInt(stats.collectedMonWei.toFixed(0))).toBeLessThanOrEqual(
      drop * 2n,
    );
  });

  it("pays nothing when the daily cap is unconfigured", async () => {
    const hunt = await makeHunt({
      spawnDailyCapWeiPerPlayer: "0",
    } as never);
    const actor = await makePlayer(400);
    await makePlayerHunt(hunt.id, actor.player.id);
    const spawn = await makeSpawn({
      hunt,
      player: actor.player,
      at: AT,
      amountMonWei: "1000000000000000",
    });

    const res = await post({
      huntId: hunt.id,
      actor,
      spawnId: spawn.id,
      ip: "10.5.0.1",
    });

    expect(res.body.reason).toBe("player_daily_cap_reached");
    expect(await db.payout.count()).toBe(0);
  });
});

describe("the audit trail a payout dispute is answered from", () => {
  beforeEach(resetDatabase);

  it("files a ClaimAttempt for a refusal as well as an acceptance", async () => {
    const hunt = await makeHunt({ budgetMonWei: "0" } as never);
    const actor = await makePlayer(500);
    await makePlayerHunt(hunt.id, actor.player.id);
    const spawn = await makeSpawn({
      hunt,
      player: actor.player,
      at: AT,
      amountMonWei: "1000000000000000",
    });

    await post({ huntId: hunt.id, actor, spawnId: spawn.id, ip: "10.6.0.1" });

    // A rejection nobody recorded is a dispute nobody can answer.
    const attempts = await db.claimAttempt.findMany({
      where: { playerId: actor.player.id },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].accepted).toBe(false);
    expect(attempts[0].reason).toBe("hunt_budget_exhausted");
  });
});
