import "./helpers/env";
import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDatabase } from "./helpers/db";
import { makeHunt, makePlayer } from "./helpers/factories";
import { routeCtx } from "./helpers/http";
import { issueSession, SESSION_COOKIE } from "@/lib/auth/mera";
import { POST as claim } from "@/app/api/hunt/[huntId]/claim/route";

/* ---------------------------------------------------------------------------
   The cache-find ceilings, against a real database.

   Same shape as the collect route's, different columns: a per-player find cap
   and a hunt credit budget, both conditional UPDATEs whose affected-row count
   decides. And one guard the MON path does not have — @@unique([cacheId,
   playerId]) — which is what makes finding the same cache twice structurally
   impossible rather than merely unlikely.

   NOTE ON AUTH: unlike the collect route, this one takes no EIP-712 signature.
   A session cookie is sufficient. That is why these requests are simpler than
   the ones in collect.itest.ts, and it is recorded here rather than papered
   over, because lib/auth/eip712.ts names the claim path specifically when it
   explains why a cookie alone should not be enough.
--------------------------------------------------------------------------- */

const AT = { lat: 21.017_9, lng: -101.256_1 };
const CREDIT = 139_000_000_000_000_000_000n; // ~one month of Explorer, in WMON-wei

async function post(args: {
  huntId: string;
  actor: Awaited<ReturnType<typeof makePlayer>>;
  at?: { lat: number; lng: number };
  ip: string;
}) {
  const at = args.at ?? AT;
  const req = new Request("http://localhost/api/hunt/x/claim", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE}=${issueSession(args.actor.address)}`,
      "x-forwarded-for": args.ip,
    },
    body: JSON.stringify({
      lat: at.lat,
      lng: at.lng,
      accuracyM: 8,
      clientTs: new Date().toISOString(),
    }),
  });
  const res = await claim(req, routeCtx({ huntId: args.huntId }));
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

function makeCache(huntId: string, rewardCreditWei: bigint) {
  return db.cache.create({
    data: {
      huntId,
      lat: AT.lat,
      lng: AT.lng,
      radiusMeters: 40,
      rewardCreditWei: rewardCreditWei.toString(),
      label: "the fountain",
    },
  });
}

describe("CEILING 1 — the per-player find cap", () => {
  beforeEach(resetDatabase);

  it("counts on the PlayerHunt row, not by counting Find rows", async () => {
    const hunt = await makeHunt({ maxFindsPerPlayer: 2 } as never);
    const actor = await makePlayer(10);
    await Promise.all([
      makeCache(hunt.id, CREDIT),
      makeCache(hunt.id, CREDIT),
      makeCache(hunt.id, CREDIT),
    ]);

    // Three caches stacked at one spot, so each request has one left to find.
    const bodies: Record<string, unknown>[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await post({ huntId: hunt.id, actor, ip: `10.9.0.${i}` });
      bodies.push(res.body);
    }

    expect(bodies[0].found).toBe(true);
    expect(bodies[1].found).toBe(true);
    expect(bodies[2].found).toBe(false);

    // THE CLIENT IS TOLD NOTHING. Every non-accept collapses to one opaque
    // string, because a claim endpoint with distinguishable outcomes is a
    // location oracle that pays for itself: grid-search at ~35m spacing and the
    // probe IS the payout. So the cap is confirmed from the audit row, which is
    // where the precise reason goes.
    expect(bodies[2].reason).toBe("no_find_here");

    const attempts = await db.claimAttempt.findMany({
      where: { playerId: actor.player.id },
      orderBy: { attemptedAt: "asc" },
    });
    expect(attempts.map((a) => a.accepted)).toEqual([true, true, false]);
    expect(attempts[2].reason).toBe("player_cap_reached");

    const stats = await db.playerHunt.findFirstOrThrow({
      where: { huntId: hunt.id, playerId: actor.player.id },
    });
    expect(stats.findCount).toBe(2);
    expect(await db.find.count()).toBe(2);
  });

  it("tells a probe the same thing whether or not a cache is there", async () => {
    // The oracle defence, measured. Standing on a cache with the cap reached
    // and standing in an empty field must be indistinguishable to the client.
    const hunt = await makeHunt({ maxFindsPerPlayer: 0 } as never);
    const actor = await makePlayer(12);
    await makeCache(hunt.id, CREDIT);

    const onACacheAlreadyFound = await post({
      huntId: hunt.id,
      actor,
      ip: "10.15.0.1",
    });
    expect(onACacheAlreadyFound.body.found).toBe(true);

    const secondVisit = await post({ huntId: hunt.id, actor, ip: "10.15.0.2" });
    const emptyField = await post({
      huntId: hunt.id,
      actor,
      at: { lat: 21.09, lng: -101.31 },
      ip: "10.15.0.3",
    });

    expect(secondVisit.body).toEqual(emptyField.body);
    expect(secondVisit.status).toBe(emptyField.status);

    // Same answer to the player, different answers in the audit trail.
    const attempts = await db.claimAttempt.findMany({
      where: { playerId: actor.player.id, accepted: false },
    });
    expect(new Set(attempts.map((a) => a.reason)).size).toBe(2);
  });

  it("creates the counter row on a first claim without racing itself", async () => {
    // The PlayerHunt row is created with ON CONFLICT DO NOTHING rather than
    // prisma.upsert, because an upsert is a read-then-insert: two first-time
    // claims by the same player race and one takes a unique violation, which
    // inside a Postgres transaction aborts everything and gets filed as
    // "already_found" — a legitimate find refused, and an audit row asserting
    // something that never happened.
    const hunt = await makeHunt();
    const actor = await makePlayer(11);
    await Promise.all([
      makeCache(hunt.id, CREDIT),
      makeCache(hunt.id, CREDIT),
    ]);

    const results = await Promise.all([
      post({ huntId: hunt.id, actor, ip: "10.10.0.1" }),
      post({ huntId: hunt.id, actor, ip: "10.10.0.2" }),
    ]);

    // Neither may be refused as already_found: they are different caches, and
    // this player had no counter row when both started.
    expect(
      results.filter((r) => r.body.reason === "already_found"),
    ).toEqual([]);

    const rows = await db.playerHunt.count({
      where: { huntId: hunt.id, playerId: actor.player.id },
    });
    expect(rows).toBe(1);
  });
});

describe("CEILING 2 — the hunt credit budget", () => {
  beforeEach(resetDatabase);

  it("never issues more credit than the budget, concurrently", async () => {
    // Budget for two finds; five players each standing on their own cache.
    const hunt = await makeHunt({
      budgetCreditWei: (CREDIT * 2n).toString(),
    } as never);

    const actors = await Promise.all(
      Array.from({ length: 5 }, (_, i) => makePlayer(20 + i)),
    );
    for (const _ of actors) await makeCache(hunt.id, CREDIT);

    const results = await Promise.all(
      actors.map((actor, i) =>
        post({ huntId: hunt.id, actor, ip: `10.11.0.${i}` }),
      ),
    );

    const found = results.filter((r) => r.body.found === true);

    const after = await db.hunt.findUniqueOrThrow({ where: { id: hunt.id } });
    const spent = BigInt(after.spentCreditWei.toFixed(0));

    // The invariant, at any level of contention.
    expect(spent).toBeLessThanOrEqual(BigInt(after.budgetCreditWei.toFixed(0)));
    expect(spent).toBe(CREDIT * BigInt(found.length));
    expect(found.length).toBeLessThanOrEqual(2);

    // Credit issued and credit recorded in the ledger must agree. A find that
    // advanced the counter without a ledger row is credit nobody can trace.
    const ledger = await db.creditLedger.aggregate({
      _sum: { amountWei: true },
    });
    expect(BigInt((ledger._sum.amountWei ?? 0).toString())).toBe(spent);
  });

  it("treats budgetCreditWei = 0 as no ceiling, unlike the MON path", async () => {
    // Deliberately asymmetric with budgetMonWei, where 0 pays nothing. Credit
    // is a discount rather than cash, so an unconfigured credit budget is
    // "unlimited" while an unconfigured MON budget is "nothing". Anyone tidying
    // these two into consistency would turn one of them into a money bug.
    const hunt = await makeHunt({ budgetCreditWei: "0" } as never);
    const actor = await makePlayer(30);
    await makeCache(hunt.id, CREDIT);

    const res = await post({ huntId: hunt.id, actor, ip: "10.12.0.1" });

    expect(res.body.found).toBe(true);
    const after = await db.hunt.findUniqueOrThrow({ where: { id: hunt.id } });
    expect(BigInt(after.spentCreditWei.toFixed(0))).toBe(CREDIT);
  });
});

describe("finding the same cache twice", () => {
  beforeEach(resetDatabase);

  it("is refused by the unique index, not by a prior read", async () => {
    const hunt = await makeHunt();
    const actor = await makePlayer(40);
    const cache = await makeCache(hunt.id, CREDIT);

    const first = await post({ huntId: hunt.id, actor, ip: "10.13.0.1" });
    const second = await post({ huntId: hunt.id, actor, ip: "10.13.0.2" });

    expect(first.body.found).toBe(true);
    expect(second.body.found).not.toBe(true);

    expect(await db.find.count({ where: { cacheId: cache.id } })).toBe(1);

    // And the refusal must not have advanced any counter. A rolled-back
    // ceiling that stayed advanced is credit the hunt can never issue.
    const after = await db.hunt.findUniqueOrThrow({ where: { id: hunt.id } });
    expect(BigInt(after.spentCreditWei.toFixed(0))).toBe(CREDIT);
    const stats = await db.playerHunt.findFirstOrThrow({
      where: { huntId: hunt.id, playerId: actor.player.id },
    });
    expect(stats.findCount).toBe(1);
  });

  it("rolls both ceilings back together when the insert loses", async () => {
    // The failure that matters is a partial commit: findCount advanced,
    // spentCreditWei advanced, no Find row. Both counters are checked against
    // the one Find that exists.
    const hunt = await makeHunt();
    const actor = await makePlayer(41);
    await makeCache(hunt.id, CREDIT);

    await Promise.all([
      post({ huntId: hunt.id, actor, ip: "10.14.0.1" }),
      post({ huntId: hunt.id, actor, ip: "10.14.0.2" }),
      post({ huntId: hunt.id, actor, ip: "10.14.0.3" }),
    ]);

    const finds = await db.find.count();
    const hunt2 = await db.hunt.findUniqueOrThrow({ where: { id: hunt.id } });
    const stats = await db.playerHunt.findFirstOrThrow({
      where: { huntId: hunt.id, playerId: actor.player.id },
    });

    expect(finds).toBe(1);
    expect(stats.findCount).toBe(finds);
    expect(BigInt(hunt2.spentCreditWei.toFixed(0))).toBe(
      CREDIT * BigInt(finds),
    );
  });
});
