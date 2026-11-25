// Route tests for the real-money allowlist (lib/cota/real-money.ts).
//
// Every money-moving entry point is called three ways: as an allowlisted
// wallet (must get past the gate), as a wallet not on the list (must get 403 /
// allow:false and reach nothing that spends), and with the env unset (nobody
// gets through). The exits — closing a position, turning autonomy off — must
// stay open to a wallet that is not on the list.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FOUNDER = "0x52908400098527886e0f7030069857d2e4169ee7";
const OTHER = "0xde709f2102306220921060314715629080e2fb77";

const session = vi.hoisted(() => ({ wallet: "" }));

vi.mock("@/lib/auth", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return {
    ...actual,
    requirePlayer: vi.fn(async () => ({
      id: "player-1",
      walletAddress: session.wallet,
      active: true,
      suspendedAt: null,
    })),
  };
});

const db = vi.hoisted(() => ({
  cota: {
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  cotaCheck: { create: vi.fn() },
  cotaAgentDecision: { create: vi.fn() },
  auroraDepositAddress: { findMany: vi.fn(), upsert: vi.fn() },
}));
vi.mock("@/lib/db/prisma", () => ({ prisma: db }));

vi.mock("@/lib/ratelimit", () => ({
  checkLimit: vi.fn(async () => ({ ok: true })),
}));

const venue = vi.hoisted(() => ({ placeOrder: vi.fn() }));
vi.mock("@/lib/cota/venue/client", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/cota/venue/client")
  >("@/lib/cota/venue/client");
  return { ...actual, placeOrder: venue.placeOrder };
});

const keys = vi.hoisted(() => ({
  storePerpKey: vi.fn(),
  loadPerpKey: vi.fn(),
  getPerpKeyStatus: vi.fn(),
}));
vi.mock("@/lib/cota/keystore", () => keys);

vi.mock("@/lib/cota/venue/market-data", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/cota/venue/market-data")
  >("@/lib/cota/venue/market-data");
  return { ...actual, readMark: vi.fn(async () => 0.02) };
});

vi.mock("@/lib/cota/venue/account-read", () => ({
  readAccountPositions: vi.fn(async () => ({
    positions: [{ marketId: 99 }],
    account: { forwardingAllowed: true },
  })),
}));

vi.mock("@/lib/cota/venue/aggregate", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/cota/venue/aggregate")
  >("@/lib/cota/venue/aggregate");
  return {
    ...actual,
    signedSizeFromFrame: vi.fn(() => 500),
    entryUsdWithResidue: vi.fn(() => 0.02),
  };
});

vi.mock("@/lib/cota/ledger", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/cota/ledger")>(
      "@/lib/cota/ledger",
    );
  return {
    ...actual,
    recordFill: vi.fn(),
    recordPlacedOrder: vi.fn(),
  };
});

const grants = vi.hoisted(() => ({ verifyStoredGrant: vi.fn() }));
vi.mock("@/lib/cota/autonomy", async () => {
  const actual = await vi.importActual<typeof import("@/lib/cota/autonomy")>(
    "@/lib/cota/autonomy",
  );
  return { ...actual, verifyStoredGrant: grants.verifyStoredGrant };
});

const aurora = vi.hoisted(() => ({
  requestPersistentDepositAddress: vi.fn(),
  readPersistentDeposits: vi.fn(),
}));
vi.mock("@/lib/cota/aurora", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/cota/aurora")>(
      "@/lib/cota/aurora",
    );
  return { ...actual, ...aurora };
});

import { MON_MARKET, T_CLOSE_LONG } from "@/lib/cota/order";
import { AuroraError } from "@/lib/cota/aurora";
import * as signRoute from "@/app/api/cota/route";
import * as tradeRoute from "@/app/api/cota/trade/route";
import * as proposeRoute from "@/app/api/cota/propose/route";
import * as autonomyRoute from "@/app/api/cota/autonomy/route";
import * as perpKeyRoute from "@/app/api/cota/perp-key/route";
import * as auroraRoute from "@/app/api/cota/aurora/route";
import * as enrollPayloadRoute from "@/app/api/cota/enroll/payload/route";
import * as enrollSubmitRoute from "@/app/api/cota/enroll/submit/route";
import * as checkRoute from "@/app/api/cota/check/route";
import * as agentRunRoute from "@/app/api/cota/agent/run/route";
import * as closeRoute from "@/app/api/cota/close/route";
import * as accessRoute from "@/app/api/cota/access/route";

const DIGEST = "0x" + "ab".repeat(32);
const AGENT_TOKEN = "test-agent-token-0123456789";

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
function get(path: string) {
  return new Request(`http://localhost${path}`);
}

// Each money entry point, with a request that would otherwise be accepted far
// enough to touch something. `spends` lists the mocks a refusal must not reach.
const gated: Array<{
  name: string;
  call: () => Promise<Response>;
  spends: Array<ReturnType<typeof vi.fn>>;
}> = [
  {
    name: "POST /api/cota (sign a leash)",
    call: () => signRoute.POST(post("/api/cota", {})),
    spends: [db.cota.create],
  },
  {
    name: "POST /api/cota/trade",
    call: () =>
      tradeRoute.POST(
        post("/api/cota/trade", {
          market: "MON",
          side: "long",
          targetNotionalUsd: 10,
          leverageX: 2,
        }),
      ),
    spends: [venue.placeOrder, keys.loadPerpKey],
  },
  {
    name: "POST /api/cota/propose",
    call: () => proposeRoute.POST(post("/api/cota/propose", {})),
    spends: [db.cota.findFirst],
  },
  {
    name: "POST /api/cota/autonomy (grant)",
    call: () =>
      autonomyRoute.POST(
        post("/api/cota/autonomy", {
          digest: DIGEST,
          mode: "full",
          signature: "0x" + "11".repeat(65),
          nonce: "nonce-12345678",
          notAfter: Math.floor(Date.now() / 1000) + 3600,
        }),
      ),
    spends: [db.cota.update],
  },
  {
    name: "POST /api/cota/perp-key",
    call: () =>
      perpKeyRoute.POST(
        post("/api/cota/perp-key", {
          apiKey: "api-key-123456",
          secretHex: "00".repeat(32),
          account: OTHER,
        }),
      ),
    spends: [keys.storePerpKey],
  },
  {
    name: "GET /api/cota/aurora",
    call: () => auroraRoute.GET(get("/api/cota/aurora")),
    spends: [db.auroraDepositAddress.findMany],
  },
  {
    name: "POST /api/cota/aurora",
    call: () => auroraRoute.POST(post("/api/cota/aurora", {})),
    spends: [
      db.auroraDepositAddress.findMany,
      aurora.requestPersistentDepositAddress,
    ],
  },
  {
    name: "POST /api/cota/enroll/payload",
    call: () => enrollPayloadRoute.POST(post("/api/cota/enroll/payload", {})),
    spends: [],
  },
  {
    name: "POST /api/cota/enroll/submit",
    call: () => enrollSubmitRoute.POST(post("/api/cota/enroll/submit", {})),
    spends: [],
  },
];

const fetchSpy = vi.fn();
const prevAllow = process.env.COTA_REAL_MONEY_ALLOWLIST;
const prevToken = process.env.COTA_AGENT_TOKEN;
const prevOrigin = process.env.PERPL_ORIGIN;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.COTA_REAL_MONEY_ALLOWLIST = FOUNDER;
  process.env.COTA_AGENT_TOKEN = AGENT_TOKEN;
  process.env.PERPL_ORIGIN = "https://hunt.example";
  session.wallet = OTHER;
  // Anything that gets past the gate meets an empty database.
  db.cota.findFirst.mockResolvedValue(null);
  db.cota.findUnique.mockResolvedValue(null);
  db.cota.findMany.mockResolvedValue([]);
  db.cota.count.mockResolvedValue(0);
  db.cotaAgentDecision.create.mockResolvedValue({});
  db.auroraDepositAddress.findMany.mockResolvedValue([]);
  keys.loadPerpKey.mockResolvedValue(null);
  keys.storePerpKey.mockResolvedValue(undefined);
  aurora.requestPersistentDepositAddress.mockRejectedValue(
    new AuroraError("aurora unreachable in tests", 503),
  );
  fetchSpy.mockResolvedValue(new Response("nope", { status: 418 }));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [k, v] of [
    ["COTA_REAL_MONEY_ALLOWLIST", prevAllow],
    ["COTA_AGENT_TOKEN", prevToken],
    ["PERPL_ORIGIN", prevOrigin],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe.each(gated)("$name", ({ call, spends }) => {
  it("refuses a wallet that is not on the allowlist", async () => {
    session.wallet = OTHER;
    const res = await call();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Real-money trading is closed for now.",
      reason: "real_money_closed",
    });
    for (const s of spends) expect(s).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses the founder too when the allowlist is empty", async () => {
    session.wallet = FOUNDER;
    process.env.COTA_REAL_MONEY_ALLOWLIST = "";
    expect((await call()).status).toBe(403);
    delete process.env.COTA_REAL_MONEY_ALLOWLIST;
    expect((await call()).status).toBe(403);
    for (const s of spends) expect(s).not.toHaveBeenCalled();
  });

  it("lets an allowlisted wallet past the gate (checksummed env)", async () => {
    session.wallet = FOUNDER;
    process.env.COTA_REAL_MONEY_ALLOWLIST =
      "0x52908400098527886E0F7030069857D2E4169EE7";
    const res = await call();
    expect(res.status).not.toBe(403);
    const body = (await res.json().catch(() => ({}))) as { reason?: string };
    expect(body.reason).not.toBe("real_money_closed");
  });
});

describe("POST /api/cota/autonomy (off)", () => {
  it("lets a wallet NOT on the list turn the agent off", async () => {
    session.wallet = OTHER;
    process.env.COTA_REAL_MONEY_ALLOWLIST = "";
    db.cota.findFirst.mockResolvedValue({
      id: "c1",
      revokedAt: null,
      anchorTxHash: null,
      markets: ["MON"],
      notAfter: new Date(Date.now() + 3600_000),
    });
    db.cota.update.mockResolvedValue({
      digest: DIGEST,
      autonomy: null,
      autonomyAt: null,
      autonomySignature: null,
      autonomyNonce: null,
      autonomyNotAfter: null,
    });
    grants.verifyStoredGrant.mockResolvedValue({ mode: "off" });
    const res = await autonomyRoute.POST(
      post("/api/cota/autonomy", { digest: DIGEST, mode: "off" }),
    );
    expect(res.status).toBe(200);
    expect(db.cota.update).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/cota/close (exit)", () => {
  it("lets a wallet NOT on the list close its own position", async () => {
    session.wallet = OTHER;
    process.env.COTA_REAL_MONEY_ALLOWLIST = "";
    keys.loadPerpKey.mockResolvedValue({
      apiKey: "k",
      secretHex: "00".repeat(32),
      account: OTHER,
    });
    const { readAccountPositions } =
      await import("@/lib/cota/venue/account-read");
    vi.mocked(readAccountPositions).mockResolvedValue({
      positions: [{ marketId: MON_MARKET.id }],
      account: { forwardingAllowed: true },
    } as never);
    venue.placeOrder.mockResolvedValue({
      account: null,
      sentToVenue: true,
      accepted: true,
      filled: false,
      code: 0,
      error: null,
      fill: null,
      update: null,
      requestId: 1,
    });
    const res = await closeRoute.POST(
      post("/api/cota/close", { market: "MON" }),
    );
    expect(res.status).toBe(200);
    expect(venue.placeOrder).toHaveBeenCalledTimes(1);
    const sent = venue.placeOrder.mock.calls[0][0];
    expect(sent.ownerWallet).toBe(OTHER);
    expect(sent.orderType).toBe(T_CLOSE_LONG);
  });
});

describe("POST /api/cota/check (agent seam)", () => {
  const row = (wallet: string) => ({
    id: "c1",
    venue: "perpl",
    markets: ["MON"],
    maxNotionalUsdE6: { toFixed: () => "100000000" },
    maxLeverageX100: { toFixed: () => "500" },
    maxDailyLossUsdE6: { toFixed: () => "10000000" },
    maxTradesPerDay: 10,
    notBefore: new Date(0),
    notAfter: new Date(Date.now() + 3600_000),
    revokedAt: null,
    player: { walletAddress: wallet },
  });
  const body = (withOrder: boolean) => ({
    digest: DIGEST,
    state: { tradesToday: 0, lossTodayUsdE6: "0", openNotionalUsdE6: "0" },
    ...(withOrder
      ? {
          order: {
            venue: "perpl",
            market: "MON",
            notionalUsdE6: "1000000",
            leverageX100: "100",
          },
        }
      : {}),
  });
  const call = (withOrder: boolean) =>
    checkRoute.POST(
      post("/api/cota/check", body(withOrder), {
        authorization: `Bearer ${AGENT_TOKEN}`,
      }),
    );

  it("answers allow:false for an open by a wallet not on the list", async () => {
    db.cota.findUnique.mockResolvedValue(row(OTHER));
    const res = await call(true);
    expect(await res.json()).toEqual({
      allow: false,
      reason: "real_money_closed",
    });
    expect(db.cotaCheck.create).not.toHaveBeenCalled();
  });

  it("answers allow:false for the founder when the list is empty", async () => {
    process.env.COTA_REAL_MONEY_ALLOWLIST = "";
    db.cota.findUnique.mockResolvedValue(row(FOUNDER));
    expect((await (await call(true)).json()).reason).toBe("real_money_closed");
  });

  it("judges an allowlisted wallet's open against its bound", async () => {
    db.cota.findUnique.mockResolvedValue(row(FOUNDER));
    db.cotaCheck.create.mockResolvedValue({});
    const res = await call(true);
    expect((await res.json()).reason).not.toBe("real_money_closed");
    expect(db.cotaCheck.create).toHaveBeenCalledTimes(1);
  });

  it("still answers a halt poll for a wallet not on the list", async () => {
    db.cota.findUnique.mockResolvedValue(row(OTHER));
    const res = await call(false);
    expect((await res.json()).reason).not.toBe("real_money_closed");
  });
});

describe("POST /api/cota/agent/run", () => {
  const candidate = (wallet: string) => ({
    id: "c1",
    playerId: "player-1",
    digest: DIGEST,
    markets: ["MON"],
    autonomy: "full",
    autonomySignature: "0x",
    autonomyNonce: "n",
    autonomyNotAfter: new Date(Date.now() + 3600_000),
    player: { id: "player-1", walletAddress: wallet },
  });
  const run = () =>
    agentRunRoute.POST(
      post(
        "/api/cota/agent/run",
        {},
        {
          authorization: `Bearer ${AGENT_TOKEN}`,
        },
      ),
    );

  it("skips a hunter who is not on the list before anything is read", async () => {
    db.cota.findMany.mockResolvedValue([candidate(OTHER)]);
    const res = await run();
    const json = (await res.json()) as { results: Array<{ why: string }> };
    expect(json.results).toEqual([
      expect.objectContaining({ act: "nothing", why: "real_money_closed" }),
    ]);
    expect(grants.verifyStoredGrant).not.toHaveBeenCalled();
    expect(keys.loadPerpKey).not.toHaveBeenCalled();
    expect(venue.placeOrder).not.toHaveBeenCalled();
  });

  it("skips everyone when the list is empty", async () => {
    process.env.COTA_REAL_MONEY_ALLOWLIST = "";
    db.cota.findMany.mockResolvedValue([candidate(FOUNDER)]);
    const json = (await (await run()).json()) as {
      results: Array<{ why: string }>;
    };
    expect(json.results[0].why).toBe("real_money_closed");
  });

  it("goes on to the grant check for an allowlisted hunter", async () => {
    db.cota.findMany.mockResolvedValue([candidate(FOUNDER)]);
    grants.verifyStoredGrant.mockResolvedValue({
      mode: "off",
      reason: "test",
    });
    const json = (await (await run()).json()) as {
      results: Array<{ why: string }>;
    };
    expect(grants.verifyStoredGrant).toHaveBeenCalledTimes(1);
    expect(json.results[0].why).toBe("grant_test");
  });
});

describe("GET /api/cota/access", () => {
  it("reports true only for an allowlisted wallet", async () => {
    session.wallet = FOUNDER;
    expect(
      await (await accessRoute.GET(get("/api/cota/access"))).json(),
    ).toEqual({
      realMoney: true,
    });
    session.wallet = OTHER;
    expect(
      await (await accessRoute.GET(get("/api/cota/access"))).json(),
    ).toEqual({
      realMoney: false,
    });
    session.wallet = FOUNDER;
    process.env.COTA_REAL_MONEY_ALLOWLIST = "";
    expect(
      await (await accessRoute.GET(get("/api/cota/access"))).json(),
    ).toEqual({
      realMoney: false,
    });
  });
});
