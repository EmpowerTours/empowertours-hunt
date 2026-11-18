import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The two Chip Board API routes, with the session, the limiter and the
// database stubbed. What is checked: the token route fails closed, mints a
// token the Go format accepts for the session's player id, and never caches;
// the leaderboard route never lets another player's id out.

const auth = vi.hoisted(() => ({
  player: null as null | {
    id: string;
    walletAddress: string;
    active: boolean;
    suspendedAt: Date | null;
  },
}));

vi.mock("@/lib/auth", () => {
  class AuthError extends Error {}
  return {
    AuthError,
    clientIp: () => "127.0.0.1",
    requirePlayer: async () => {
      if (!auth.player) throw new AuthError("unauthenticated");
      return auth.player;
    },
  };
});
vi.mock("@/lib/ratelimit", () => ({
  checkLimit: async () => ({ ok: true, remaining: 1, resetAt: 0 }),
}));
vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    cotasProfile: {
      findMany: async ({ where }: { where: { playerId: { in: string[] } } }) =>
        where.playerId.in
          .filter((id) => id === "listed1")
          .map((id) => ({ playerId: id, alias: "lupita" })),
    },
  },
}));

const SECRET = "route-test-secret-route-test-secret-0123";
const req = () =>
  new Request("http://localhost/api/chipboard/token", { method: "POST" });

beforeEach(() => {
  auth.player = {
    id: "cmh3k9x2a0000qz8v7y1b2c3d",
    walletAddress: "0xabc",
    active: true,
    suspendedAt: null,
  };
  vi.stubEnv("CHIPBOARD_SESSION_SECRET", SECRET);
  vi.stubEnv("NEXT_PUBLIC_CHIPBOARD_WS_URL", "ws://localhost:8090/ws");
  vi.stubEnv("CHIPBOARD_HTTP_URL", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("POST /api/chipboard/token", () => {
  it("mints a short-lived token for the session's player id", async () => {
    const { POST } = await import("@/app/api/chipboard/token/route");
    const before = Math.floor(Date.now() / 1000);
    const r = await POST(req());
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const j = (await r.json()) as { token: string; wsUrl: string };
    expect(j.wsUrl).toBe("ws://localhost:8090/ws");
    const [id, exp, sig] = j.token.split(".");
    expect(id).toBe("cmh3k9x2a0000qz8v7y1b2c3d");
    expect(Number(exp) - before).toBeGreaterThan(0);
    expect(Number(exp) - before).toBeLessThanOrEqual(121);
    expect(sig).toBe(
      createHmac("sha256", SECRET).update(`${id}.${exp}`).digest("base64url"),
    );
  });

  it("fails closed without a usable secret or WS URL", async () => {
    const { POST } = await import("@/app/api/chipboard/token/route");
    vi.stubEnv("CHIPBOARD_SESSION_SECRET", "too-short");
    expect((await POST(req())).status).toBe(503);
    vi.stubEnv("CHIPBOARD_SESSION_SECRET", "");
    expect((await POST(req())).status).toBe(503);
    vi.stubEnv("CHIPBOARD_SESSION_SECRET", SECRET);
    vi.stubEnv("NEXT_PUBLIC_CHIPBOARD_WS_URL", "https://not-a-ws-url");
    expect((await POST(req())).status).toBe(503);
  });

  it("refuses signed-out and inactive players", async () => {
    const { POST } = await import("@/app/api/chipboard/token/route");
    auth.player = null;
    expect((await POST(req())).status).toBe(401);
    auth.player = {
      id: "x",
      walletAddress: "0x1",
      active: false,
      suspendedAt: null,
    };
    expect((await POST(req())).status).toBe(403);
  });
});

describe("GET /api/chipboard/leaderboard", () => {
  it("shows aliases only for listed players and no ids at all", async () => {
    const me = "cmh3k9x2a0000qz8v7y1b2c3d";
    const standings = Array.from({ length: 12 }, (_, i) => ({
      player: i === 0 ? "listed1" : `other${i}`,
      points: 100 - i,
      rounds: 20 + i,
      qualified: true,
      rank: i + 1,
    }));
    standings.push({
      player: me,
      points: -5,
      rounds: 3,
      qualified: false,
      rank: 13,
    });
    const fetchMock = vi.fn(async () =>
      Response.json({
        day: "2026-11-18",
        players: 13,
        qualifyRounds: 20,
        standings,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("@/app/api/chipboard/leaderboard/route");
    const r = await GET(
      new Request("http://localhost/api/chipboard/leaderboard"),
    );
    expect(r.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0 as never])).toBe(
      "http://localhost:8090/leaderboard?limit=1000",
    );
    const body = await r.text();
    expect(body).not.toContain("other");
    expect(body).not.toContain(me);
    expect(body).not.toContain("listed1");
    const j = JSON.parse(body) as {
      rows: Array<{ rank: number; alias: string | null; me: boolean }>;
      me: { rank: number };
    };
    expect(j.rows).toHaveLength(11); // top 10 + me
    expect(j.rows[0]).toMatchObject({ rank: 1, alias: "lupita", me: false });
    expect(j.rows[1].alias).toBeNull();
    expect(j.rows[10]).toMatchObject({ rank: 13, me: true });
    expect(j.me.rank).toBe(13);
  });

  it("answers 503 when the game server is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const { GET } = await import("@/app/api/chipboard/leaderboard/route");
    const r = await GET(
      new Request("http://localhost/api/chipboard/leaderboard"),
    );
    expect(r.status).toBe(503);
  });
});
