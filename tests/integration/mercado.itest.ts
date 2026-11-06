import "./helpers/env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDatabase } from "./helpers/db";
import { makePlayer } from "./helpers/factories";
import { issueSession, SESSION_COOKIE } from "@/lib/auth/mera";
import type { Candle } from "@/lib/mercado/game";

/* ---------------------------------------------------------------------------
   Haz Mercado against a real database, with Perpl's candles and the clock
   scripted.

   What a pure test cannot show: that two tabs starting a match get one match,
   that concurrent polls settle a round once, that a client cannot name a price,
   and that the board reads only finished matches of listed players.
--------------------------------------------------------------------------- */

const feed = vi.hoisted(() => ({ candles: [] as Candle[] }));
vi.mock("@/lib/mercado/feed", async (orig) => {
  const real = await orig<typeof import("@/lib/mercado/feed")>();
  return {
    ...real,
    candlesSince: async (since: number) =>
      feed.candles.filter((c) => c.t >= since),
    latestPrice: async () => {
      const last = feed.candles[feed.candles.length - 1];
      return last ? { price: last.c, t: last.t } : null;
    },
    recentTrail: async () => feed.candles.map((c) => ({ t: c.t, p: c.c })),
  };
});

const { GET, POST } = await import("@/app/api/mercado/route");
const board = await import("@/app/api/mercado/tabla/route");
const service = await import("@/lib/mercado/service");

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 2, 18, 0); // a Monday afternoon in Mexico City
const c = (i: number, close: number): Candle => ({
  t: T0 + i * MIN,
  o: close,
  h: close,
  l: close,
  c: close,
  n: 3,
});

function req(path: string, address: string, body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE}=${issueSession(address)}`,
      "x-forwarded-for": "10.0.0.1",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
 
async function get(address: string) {
  const r = await GET(req("/api/mercado", address));
  return { status: r.status, body: (await r.json()) as Record<string, any> };
}
async function post(address: string, body: unknown) {
  const r = await POST(req("/api/mercado", address, body));
  return { status: r.status, body: (await r.json()) as Record<string, any> };
}
 

const at = (ms: number) => vi.setSystemTime(new Date(ms));

beforeEach(async () => {
  await resetDatabase();
  vi.useFakeTimers({ toFake: ["Date"] });
  feed.candles = [0, 1, 2, 3, 4].map((i) => c(i, 17500));
  at(T0 + 5 * MIN + 10_000); // 10 s into minute 5
});
afterEach(() => vi.useRealTimers());

describe("haz mercado", () => {
  it("refuses without a session", async () => {
    const r = await GET(new Request("http://localhost/api/mercado"));
    expect(r.status).toBe(401);
  });

  it("five simultaneous starts make one match, opened on the bot's quote", async () => {
    const p = await makePlayer(1);
    expect((await get(p.address)).body.match).toBeNull();
    const all = await Promise.all(
      Array.from({ length: 5 }, () => post(p.address, { action: "start" })),
    );
    expect(all.every((r) => r.status === 200)).toBe(true);
    expect(await db.mercadoMatch.count()).toBe(1);
    // The route's auth and rate limit happen to serialize these; call the
    // service directly so five starts really do overlap.
    const q = await makePlayer(7);
    await Promise.all(
      Array.from({ length: 5 }, () => service.start(q.player.id)),
    );
    expect(
      await db.mercadoMatch.count({ where: { playerId: q.player.id } }),
    ).toBe(1);
    const m = all[0].body.match;
    expect(m.current).toMatchObject({ n: 1, quoter: "bot" });
    expect(m.rounds[0].bid).toBeLessThan(17500);
    expect(m.rounds[0].ask).toBeGreaterThan(17500);
  });

  it("a buy settles once on the next minute's close, however many tabs poll", async () => {
    const p = await makePlayer(2);
    const ask = (await post(p.address, { action: "start" })).body.match
      .rounds[0].ask as number;
    const took = await post(p.address, { action: "take", side: "buy" });
    expect(took.status).toBe(200);
    const r1 = took.body.match.rounds[0];
    expect(r1.settleAt).toBe(T0 + 7 * MIN); // minute 6 closes at 7:00
    // round 2 opened straight away: the player quotes
    expect(took.body.match.current).toMatchObject({ n: 2, quoter: "you" });

    feed.candles.push(c(5, 17500), c(6, ask + 10));
    at(T0 + 7 * MIN + 6_000);
    const polls = await Promise.all(
      Array.from({ length: 6 }, () => get(p.address)),
    );
    expect(polls.some((r) => r.status === 200)).toBe(true);
    const final = (await get(p.address)).body.match;
    expect(final.rounds[0].close).toBe(ask + 10);
    const expected = Math.round((10 * 1e5) / 17500);
    expect(final.rounds[0].you).toBe(expected);
    // round 2 ran out while we waited: a timeout penalty, not a double booking
    expect(final.you).toBe(expected - 50);
  });

  it("places the walls around the live price, refuses walls too close, and any field it did not ask for", async () => {
    const p = await makePlayer(3);
    await post(p.address, { action: "start" });
    await post(p.address, { action: "take", side: "pass" });
    const tight = await post(p.address, { action: "quote", below: 1, above: 1 });
    expect(tight.status).toBe(422);
    expect(tight.body.reason).toBe("spread_too_small");
    // A client naming a price is refused outright, not ignored.
    const sneaky = await post(p.address, {
      action: "quote",
      below: 4,
      above: 4,
      price: 17000,
    });
    expect(sneaky.status).toBe(400);
    // MON trades at 17530 after the player last looked: the walls follow it.
    feed.candles.push(c(5, 17530));
    const ok = await post(p.address, { action: "quote", below: 4, above: 4 });
    expect(ok.status).toBe(200);
    expect(ok.body.match.rounds[1]).toMatchObject({ ref: 17530, bid: 17526, ask: 17534 });
    expect(ok.body.match.rounds[1].action).toMatch(/buy|sell|pass/);
  });

  it("the board lists only listed players with 3 finished matches, by average", async () => {
    const [a, b, hidden] = await Promise.all([
      makePlayer(4),
      makePlayer(5),
      makePlayer(6),
    ]);
    const finishedAt = new Date(T0 + 60 * MIN);
    const rows = (playerId: string, scores: number[]) =>
      scores.map((you) => ({ playerId, state: {}, you, finishedAt }));
    await db.mercadoMatch.createMany({
      data: [
        ...rows(a.player.id, [100, 100, 100]),
        ...rows(b.player.id, [300, -50, 0]),
        ...rows(hidden.player.id, [900, 900, 900]),
        { playerId: b.player.id, state: {}, you: 999 }, // unfinished: not counted
      ],
    });
    await db.cotasProfile.createMany({
      data: [
        {
          playerId: a.player.id,
          alias: "alfa",
          aliasKey: "alfa",
          listed: true,
        },
        {
          playerId: b.player.id,
          alias: "beta",
          aliasKey: "beta",
          listed: true,
        },
        {
          playerId: hidden.player.id,
          alias: "zeta",
          aliasKey: "zeta",
          listed: false,
        },
      ],
    });
    const r = await board.GET(
      new Request("http://localhost/api/mercado/tabla"),
    );
    const j = (await r.json()) as {
      board: Array<{ alias: string; avg: number }>;
    };
    expect(j.board.map((x) => x.alias)).toEqual(["alfa", "beta"]);
    expect(j.board[0].avg).toBe(100);
  });
});
