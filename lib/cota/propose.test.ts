import { describe, expect, it, vi } from "vitest";
import type { DayState, EnforcedBound } from "./enforce";
import { proposeOrder, ProposerError } from "./propose";

// A live bound: BTC/ETH on perpl, 5x, $200 total, $50 daily loss, 3 trades/day.
const NOW = 1_760_000_000n;
const bound: EnforcedBound = {
  venue: "perpl",
  markets: ["BTC-PERP", "ETH-PERP"],
  maxNotionalUsdE6: 200_000_000n, // $200
  maxLeverageX100: 500n, // 5x
  maxDailyLossUsdE6: 50_000_000n, // $50
  maxTradesPerDay: 3,
  notBefore: NOW - 100n,
  notAfter: NOW + 100_000n,
  revokedAt: null,
};

const freshDay: DayState = {
  tradesToday: 0,
  lossTodayUsdE6: 0n,
  openNotionalUsdE6: 0n,
};

const markets = [{ market: "BTC-PERP", priceUsd: 60000, change24hPct: 1.2 }];

// A fake Kimi endpoint returning one canned proposal, and recording the request
// so we can assert the key and shape reached the wire.
function kimiReturning(
  content: unknown,
  init: { ok?: boolean; status?: number; rawContent?: string } = {},
) {
  const calls: {
    url: string;
    headers: Record<string, string>;
    body: unknown;
  }[] = [];
  const fake = vi.fn(async (url: string, opts: RequestInit) => {
    calls.push({
      url,
      headers: opts.headers as Record<string, string>,
      body: JSON.parse(opts.body as string),
    });
    // The envelope is always valid JSON (as Kimi's HTTP body is); rawContent
    // lets a test make the INNER message content non-JSON — the realistic
    // "model returned junk under json_object" case.
    const messageContent = init.rawContent ?? JSON.stringify(content);
    const envelope = JSON.stringify({
      choices: [{ message: { content: messageContent } }],
    });
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => JSON.parse(envelope),
      text: async () => envelope,
    } as Response;
  });
  return { fetch: fake as unknown as typeof fetch, calls };
}

describe("proposeOrder — Kimi proposes, mayOpen decides", () => {
  it("passes an in-bounds proposal through the gate", async () => {
    const { fetch } = kimiReturning({
      action: "open",
      market: "BTC-PERP",
      side: "long",
      notionalUsd: 100,
      leverage: 3,
      rationale: "trend up, small size",
    });
    const r = await proposeOrder(
      { bound, state: freshDay, markets, nowSeconds: NOW },
      { fetch, apiKey: "sk-test" },
    );
    expect(r.decision.ok).toBe(true);
    expect(r.order).not.toBeNull();
    expect(r.order?.notionalUsdE6).toBe(100_000_000n);
    expect(r.order?.leverageX100).toBe(300n);
  });

  it("REJECTS an over-leverage proposal even though Kimi asked for it", async () => {
    const { fetch } = kimiReturning({
      action: "open",
      market: "BTC-PERP",
      side: "long",
      notionalUsd: 100,
      leverage: 20, // over the 5x cap
      rationale: "high conviction",
    });
    const r = await proposeOrder(
      { bound, state: freshDay, markets, nowSeconds: NOW },
      { fetch, apiKey: "sk-test" },
    );
    expect(r.decision).toEqual({ ok: false, reason: "leverage_exceeded" });
  });

  it("REJECTS a market the leash never authorised", async () => {
    const { fetch } = kimiReturning({
      action: "open",
      market: "DOGE-PERP",
      side: "long",
      notionalUsd: 50,
      leverage: 2,
      rationale: "meme season",
    });
    const r = await proposeOrder(
      { bound, state: freshDay, markets, nowSeconds: NOW },
      { fetch, apiKey: "sk-test" },
    );
    expect(r.decision).toEqual({ ok: false, reason: "market_not_authorised" });
  });

  it("REJECTS notional that would breach the aggregate cap", async () => {
    const { fetch } = kimiReturning({
      action: "open",
      market: "ETH-PERP",
      side: "short",
      notionalUsd: 150,
      leverage: 2,
      rationale: "add size",
    });
    // $80 already open; +$150 = $230 > $200 cap.
    const r = await proposeOrder(
      {
        bound,
        state: { ...freshDay, openNotionalUsdE6: 80_000_000n },
        markets,
        nowSeconds: NOW,
      },
      { fetch, apiKey: "sk-test" },
    );
    expect(r.decision).toEqual({ ok: false, reason: "notional_exceeded" });
  });

  it("returns a no-op for a hold", async () => {
    const { fetch } = kimiReturning({
      action: "hold",
      rationale: "chop, no edge",
    });
    const r = await proposeOrder(
      { bound, state: freshDay, markets, nowSeconds: NOW },
      { fetch, apiKey: "sk-test" },
    );
    expect(r.order).toBeNull();
    expect(r.decision.ok).toBe(true);
  });

  it("sends the API key and JSON mode on the wire", async () => {
    const { fetch, calls } = kimiReturning({
      action: "hold",
      rationale: "x",
    });
    await proposeOrder(
      { bound, state: freshDay, markets, nowSeconds: NOW },
      { fetch, apiKey: "sk-secret", model: "kimi-k3" },
    );
    expect(calls[0].headers.authorization).toBe("Bearer sk-secret");
    expect((calls[0].body as { model: string }).model).toBe("kimi-k3");
    expect(
      (calls[0].body as { response_format: { type: string } }).response_format
        .type,
    ).toBe("json_object");
  });

  it("throws ProposerError when the key is missing", async () => {
    const { fetch } = kimiReturning({ action: "hold", rationale: "x" });
    await expect(
      proposeOrder(
        { bound, state: freshDay, markets, nowSeconds: NOW },
        { fetch, apiKey: "" },
      ),
    ).rejects.toBeInstanceOf(ProposerError);
  });

  it("throws ProposerError on an unparseable reply (never a silent trade)", async () => {
    const { fetch } = kimiReturning(null, { rawContent: "not json at all" });
    await expect(
      proposeOrder(
        { bound, state: freshDay, markets, nowSeconds: NOW },
        { fetch, apiKey: "sk-test" },
      ),
    ).rejects.toBeInstanceOf(ProposerError);
  });

  it("throws ProposerError on an API error status", async () => {
    const { fetch } = kimiReturning(
      { action: "hold", rationale: "x" },
      { ok: false, status: 401 },
    );
    await expect(
      proposeOrder(
        { bound, state: freshDay, markets, nowSeconds: NOW },
        { fetch, apiKey: "sk-test" },
      ),
    ).rejects.toBeInstanceOf(ProposerError);
  });
});
