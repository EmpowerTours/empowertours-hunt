import { describe, expect, it, vi } from "vitest";
import {
  fetchHoldings,
  orderForFunding,
  parseHoldings,
  ZerionError,
  type Holding,
} from "./zerion";

// ---------------------------------------------------------------------------
// Every row here is a claim about how much money somebody has, so the tests are
// about the two ways that goes wrong: a number that is wrong, and a number that
// is shown when it should not be.
//
// The fixture is the real response shape, read from the live API 2026-09-22 for
// the wallet that received the first Aurora deposit.
// ---------------------------------------------------------------------------

const LIVE = {
  data: [
    {
      type: "positions",
      attributes: {
        quantity: {
          int: "2633255",
          decimals: 6,
          float: 2.633255,
          numeric: "2.633255",
        },
        value: 2.63298114148,
        price: 0.999896,
        fungible_info: { symbol: "USDC", name: "USDC" },
      },
      relationships: { chain: { data: { type: "chains", id: "monad" } } },
    },
    {
      type: "positions",
      attributes: {
        quantity: {
          int: "24454399716000000000",
          decimals: 18,
          float: 24.454399716,
          numeric: "24.454399716",
        },
        value: 0.6483,
        fungible_info: { symbol: "MON", name: "Monad" },
      },
      relationships: { chain: { data: { type: "chains", id: "monad" } } },
    },
  ],
};

describe("reading a balance", () => {
  it("reads the real payload", () => {
    const [usdc] = parseHoldings(LIVE);
    expect(usdc).toMatchObject({
      symbol: "USDC",
      chain: "monad",
      amount: "2.633255",
      amountInt: "2633255",
      decimals: 6,
    });
  });

  it("matches what the chain says, to the last digit", () => {
    // `cast call USDC balanceOf` returned 2633255 for this wallet. Zerion is
    // only useful here if it agrees with the chain exactly — a display that
    // rounds differently from the swap screen would have a hunter chasing a
    // discrepancy that is not there.
    expect(parseHoldings(LIVE)[0]!.amountInt).toBe("2633255");
  });

  it("takes the string amount, never the float", () => {
    // `float` is in the payload and is a double. An 18-decimal balance does not
    // survive one, and MON is 18 decimals.
    const mon = parseHoldings(LIVE)[1]!;
    expect(mon.amount).toBe("24.454399716");
    expect(mon.amountInt).toBe("24454399716000000000");
  });

  it("keeps a missing price as null rather than zero", () => {
    // "$0.00" next to a real balance reads as worthless. Absent is not zero.
    const rows = parseHoldings({
      data: [
        {
          attributes: {
            quantity: { int: "1", decimals: 6, numeric: "0.000001" },
            fungible_info: { symbol: "WAT" },
          },
          relationships: { chain: { data: { id: "base" } } },
        },
      ],
    });
    expect(rows[0]!.valueUsd).toBeNull();
  });

  it("drops a row with no amount rather than showing zero of it", () => {
    const rows = parseHoldings({
      data: [
        {
          attributes: { fungible_info: { symbol: "GHOST" } },
          relationships: { chain: { data: { id: "monad" } } },
        },
        ...LIVE.data,
      ],
    });
    expect(rows.map((r) => r.symbol)).toEqual(["USDC", "MON"]);
  });

  it("returns nothing at all for a response it cannot read", () => {
    expect(parseHoldings({})).toEqual([]);
    expect(parseHoldings({ data: "no" })).toEqual([]);
    expect(parseHoldings(null)).toEqual([]);
  });
});

describe("what the funding screen shows first", () => {
  const h = (
    chain: string,
    symbol: string,
    valueUsd: number | null,
  ): Holding => ({
    symbol,
    chain,
    amount: "1",
    amountInt: "1",
    decimals: 0,
    valueUsd,
  });

  it("puts Monad above everything, whatever it is worth", () => {
    // The hunter is deciding whether to swap a Monad balance. A larger holding
    // on another chain is context, not the answer to the question they came
    // with.
    const out = orderForFunding([h("base", "ETH", 900), h("monad", "USDC", 2)]);
    expect(out.map((x) => x.chain)).toEqual(["monad", "base"]);
  });

  it("orders the rest by value", () => {
    const out = orderForFunding([
      h("base", "SMALL", 1),
      h("arbitrum", "BIG", 50),
    ]);
    expect(out.map((x) => x.symbol)).toEqual(["BIG", "SMALL"]);
  });

  it("does not crash on unpriced rows", () => {
    const out = orderForFunding([h("base", "A", null), h("base", "B", 5)]);
    expect(out.map((x) => x.symbol)).toEqual(["B", "A"]);
  });
});

describe("talking to Zerion", () => {
  it("authenticates with Basic and an empty password, not a bearer token", async () => {
    // Measured: a bearer header returns 401.
    let seen = "";
    const fake = vi.fn(async (_u: string | URL, init?: RequestInit) => {
      seen = String((init?.headers as Record<string, string>).authorization);
      return new Response(JSON.stringify(LIVE));
    }) as unknown as typeof fetch;
    await fetchHoldings("0xabc", { fetch: fake, apiKey: "KEY" });
    expect(seen.startsWith("Basic ")).toBe(true);
    expect(Buffer.from(seen.slice(6), "base64").toString()).toBe("KEY:");
  });

  it("refuses to run without a key rather than calling unauthenticated", async () => {
    const fake = vi.fn() as unknown as typeof fetch;
    await expect(
      fetchHoldings("0xabc", { fetch: fake, apiKey: "" }),
    ).rejects.toBeInstanceOf(ZerionError);
    expect(fake).not.toHaveBeenCalled();
  });

  it("throws on an HTTP error instead of returning an empty wallet", async () => {
    // [] would render as "you have nothing", which is the one wrong answer a
    // balance screen must never give.
    const fake = vi.fn(
      async () => new Response("no", { status: 500 }),
    ) as unknown as typeof fetch;
    await expect(
      fetchHoldings("0xabc", { fetch: fake, apiKey: "KEY" }),
    ).rejects.toBeInstanceOf(ZerionError);
  });
});
