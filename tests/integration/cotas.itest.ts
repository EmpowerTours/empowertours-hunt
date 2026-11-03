import "./helpers/env";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { db, resetDatabase } from "./helpers/db";
import { makePlayer } from "./helpers/factories";
import { issueSession, SESSION_COOKIE } from "@/lib/auth/mera";
import type { Candle } from "@/lib/cotas/advance";

/* ---------------------------------------------------------------------------
   Cotas against a real database, with Perpl's candles scripted.

   What a pure test cannot show: that two tabs polling at once book a crossing
   once, that the first visit grants chips exactly once, that the ledger rows
   add up to the balance the engine holds, and that the board reads only what
   the ledger says.
--------------------------------------------------------------------------- */

const feed = vi.hoisted(() => ({ candles: [] as Candle[] }));
vi.mock("@/lib/cotas/feed", async (orig) => {
  const real = await orig<typeof import("@/lib/cotas/feed")>();
  return {
    ...real,
    candlesSince: async (since: number) =>
      feed.candles.filter((c) => c.t >= since),
    latestPrice: async () => {
      const last = feed.candles[feed.candles.length - 1];
      return last ? { price: last.c, t: last.t } : null;
    },
    recentTrail: async () => [],
  };
});

const { GET, POST } = await import("@/app/api/cotas/route");
const board = await import("@/app/api/cotas/leaderboard/route");

const T0 = Date.UTC(2026, 10, 2, 18, 0); // a Monday afternoon in Mexico City
const c = (i: number, o: number, h: number, l: number, cl: number): Candle => ({
  t: T0 + i * 60_000,
  o,
  h,
  l,
  c: cl,
  n: 3,
});

function req(path: string, address: string, body?: unknown, ip = "10.0.0.1") {
  return new Request(`http://localhost${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE}=${issueSession(address)}`,
      "x-forwarded-for": ip,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function get(address: string) {
  const r = await GET(req("/api/cotas", address));
  return { status: r.status, body: (await r.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
async function post(address: string, body: unknown) {
  const r = await POST(req("/api/cotas", address, body));
  return { status: r.status, body: (await r.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

beforeEach(async () => {
  await resetDatabase();
  feed.candles = [c(0, 17530, 17530, 17530, 17530)];
});

describe("cotas", () => {
  it("refuses without a session", async () => {
    const r = await GET(new Request("http://localhost/api/cotas"));
    expect(r.status).toBe(401);
  });

  it("grants 1,000 chips exactly once, even to five simultaneous first visits", async () => {
    const p = await makePlayer(1);
    const all = await Promise.all(
      Array.from({ length: 5 }, () => get(p.address)),
    );
    expect(all.every((r) => r.status === 200)).toBe(true);
    expect(await db.cotasGame.count()).toBe(1);
    expect(await db.cotasEvent.count({ where: { kind: "grant" } })).toBe(1);
    expect(all[0].body.balance).toBe(1_000_000_000);
  });

  it("plays a crossing from Perpl's candles and books it once under concurrent polling", async () => {
    const p = await makePlayer(2);
    await get(p.address);
    const set = await post(p.address, {
      action: "walls",
      lo: 17500,
      hi: 17570,
      qty: 1000,
    });
    expect(set.status).toBe(200);

    feed.candles.push(c(1, 17530, 17535, 17499, 17510)); // touches the bottom wall
    feed.candles.push(c(2, 17510, 17575, 17505, 17560)); // reaches the top
    const polls = await Promise.all(
      Array.from({ length: 6 }, () => get(p.address)),
    );
    expect(polls.filter((r) => r.status === 200).length).toBeGreaterThan(0);

    const rows = await db.cotasEvent.findMany({
      where: { playerId: p.player.id },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.map((r) => r.kind)).toEqual(["grant", "open", "cross"]);
    const final = (await get(p.address)).body;
    expect(final.crossings).toBe(1);
    // The ledger's last balance is the engine's balance: nothing booked twice, nothing lost.
    expect(Number(rows[rows.length - 1].balanceAfter)).toBe(final.balance);
    expect(final.balance).toBe(1_000_000_000 - 5_075 + 64_905);
  });

  it("refuses walls the price is not between, and any field it did not ask for", async () => {
    const p = await makePlayer(3);
    await get(p.address);
    const bad = await post(p.address, {
      action: "walls",
      lo: 17600,
      hi: 17700,
      qty: 1000,
    });
    expect(bad.status).toBe(422);
    expect(bad.body.reason).toBe("price_not_between");
    // A client naming a price or a balance is refused outright, not ignored.
    const sneaky = await post(p.address, {
      action: "walls",
      lo: 17500,
      hi: 17570,
      qty: 1000,
      price: 17000,
    });
    expect(sneaky.status).toBe(400);
  });

  it("refills only when broke, and only once a day; the loss stays in the ledger", async () => {
    const p = await makePlayer(4);
    await get(p.address);
    expect((await post(p.address, { action: "refill" })).status).toBe(409); // not broke

    const g = await db.cotasGame.findUniqueOrThrow({
      where: { playerId: p.player.id },
    });
    await db.cotasGame.update({
      where: { id: g.id },
      data: { state: { ...(g.state as object), balance: 50_000_000 } },
    });
    const first = await post(p.address, { action: "refill" });
    expect(first.status).toBe(200);
    expect(first.body.balance).toBe(1_000_000_000);

    const g2 = await db.cotasGame.findUniqueOrThrow({
      where: { playerId: p.player.id },
    });
    await db.cotasGame.update({
      where: { id: g2.id },
      data: { state: { ...(g2.state as object), balance: 50_000_000 } },
    });
    expect((await post(p.address, { action: "refill" })).status).toBe(409); // already today
    expect(
      await db.cotasEvent.count({
        where: { playerId: p.player.id, kind: "refill" },
      }),
    ).toBe(1);
  });

  it("the board shows listed players with 10+ crossings, by return, under their alias only", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0 + 30 * 60_000);
    try {
      const a = await makePlayer(5);
      const b = await makePlayer(6);
      for (const p of [a, b]) {
        await get(p.address);
        await post(p.address, {
          action: "walls",
          lo: 17500,
          hi: 17570,
          qty: 1000,
        });
      }
      // Eleven round trips between the walls.
      let i = 1;
      for (let k = 0; k < 11; k++) {
        feed.candles.push(c(i++, 17530, 17535, 17499, 17510));
        feed.candles.push(c(i++, 17510, 17575, 17505, 17540));
        await Promise.all([get(a.address), get(b.address)]);
      }
      const set = await board.POST(
        req("/api/cotas/leaderboard", a.address, {
          alias: "Rocket_1",
          listed: true,
        }),
      );
      expect(set.status).toBe(200);
      await board.POST(
        req("/api/cotas/leaderboard", b.address, {
          alias: "Quiet",
          listed: false,
        }),
      );
      // Same alias, different case: taken.
      const dup = await board.POST(
        req("/api/cotas/leaderboard", b.address, {
          alias: "rocket_1",
          listed: true,
        }),
      );
      expect(dup.status).toBe(409);

      const r = await board.GET(req("/api/cotas/leaderboard", a.address));
      const j = (await r.json()) as {
        board: Array<Record<string, unknown>>;
        me: Record<string, unknown>;
      };
      expect(j.board).toHaveLength(1);
      expect(j.board[0]).toMatchObject({
        rank: 1,
        alias: "Rocket_1",
        crossings: 11,
        mine: true,
      });
      expect(Object.keys(j.board[0]).sort()).toEqual([
        "alias",
        "crossings",
        "escapes",
        "hitRate",
        "mine",
        "rank",
        "ret",
      ]);
      expect(j.me).toMatchObject({ crossings: 11, qualifies: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
