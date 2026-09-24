import { describe, expect, it, vi } from "vitest";
import {
  AuroraError,
  MONAD_USDC_ADDRESS,
  MONAD_MON_ASSET_ID,
  MONAD_USDC_ASSET_ID,
  isCredited,
  isTerminal,
  parseDepositQuote,
  parseDeposits,
  parseStatus,
  isDepositChain,
  isDestinationAsset,
  parsePersistentAddress,
  formatUnits,
  parsePersistentDeposits,
  readPersistentDeposits,
  requestPersistentDepositAddress,
  requestUsdcDepositAddress,
} from "./aurora";
import { USDC as KURU_USDC } from "./kuru";

// ---------------------------------------------------------------------------
// What these tests are actually protecting.
//
// This module hands a hunter an address and tells them to send money to it.
// Everything below is about the two ways that goes wrong quietly: the address
// pays out somewhere we cannot spend, or a state that is not "credited" reads
// as if it were.
// ---------------------------------------------------------------------------

const RECIPIENT = "0x1234567890AbcdEF1234567890aBcdef12345678" as const;
const ORIGIN = "nep141:wrap.near";

function quoteBody(over: Record<string, unknown> = {}) {
  return {
    depositAddress: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    originAsset: ORIGIN,
    destinationAsset: MONAD_USDC_ASSET_ID,
    recipient: RECIPIENT,
    ...over,
  };
}

describe("the two halves of the on-ramp agree on one token", () => {
  it("delivers the exact USDC the USDC->AUSD leg trades", () => {
    // The whole design rests on this equality. Aurora cannot deliver AUSD, so
    // it lands USDC and lib/cota/kuru.ts finishes the journey — which only
    // works if they mean the same contract. If Aurora ever repoints its Monad
    // USDC asset id, this is the test that says so instead of a hunter's funds
    // arriving as a token nothing downstream can spend.
    expect(MONAD_USDC_ADDRESS.toLowerCase()).toBe(KURU_USDC.toLowerCase());
  });
});

describe("parseDepositQuote", () => {
  it("accepts a quote that matches what was asked for", () => {
    const q = parseDepositQuote(quoteBody(), {
      originAsset: ORIGIN,
      recipient: RECIPIENT,
    });
    expect(q.depositAddress).toBe("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    expect(q.destinationAsset).toBe(MONAD_USDC_ASSET_ID);
  });

  it("does not care about the case of an echoed address", () => {
    const q = parseDepositQuote(
      quoteBody({ recipient: RECIPIENT.toLowerCase() }),
      { originAsset: ORIGIN, recipient: RECIPIENT },
    );
    expect(q.recipient).toBe(RECIPIENT.toLowerCase());
  });

  it("REFUSES a quote whose destination is not Monad USDC", () => {
    // The failure that matters most. A quote pointing at MON, or at USDC on
    // another chain, produces a perfectly valid-looking address that funds
    // arrive at and the AUSD leg can never spend.
    expect(() =>
      parseDepositQuote(
        quoteBody({ destinationAsset: "nep245:v2_1.omni.hot.tg:143_1111" }),
        { originAsset: ORIGIN, recipient: RECIPIENT },
      ),
    ).toThrow(AuroraError);
  });

  it("REFUSES a quote that pays out to somebody else", () => {
    expect(() =>
      parseDepositQuote(
        quoteBody({ recipient: "0x000000000000000000000000000000000000dEaD" }),
        { originAsset: ORIGIN, recipient: RECIPIENT },
      ),
    ).toThrow(AuroraError);
  });

  it("REFUSES a quote for a different origin asset", () => {
    expect(() =>
      parseDepositQuote(quoteBody({ originAsset: "nep141:btc.omft.near" }), {
        originAsset: ORIGIN,
        recipient: RECIPIENT,
      }),
    ).toThrow(AuroraError);
  });

  it("refuses a response with no deposit address rather than rendering an empty one", () => {
    expect(() =>
      parseDepositQuote(quoteBody({ depositAddress: "" }), {
        originAsset: ORIGIN,
        recipient: RECIPIENT,
      }),
    ).toThrow(AuroraError);
    expect(() =>
      parseDepositQuote({}, { originAsset: ORIGIN, recipient: RECIPIENT }),
    ).toThrow(AuroraError);
  });
});

describe("status handling is fail-closed", () => {
  it("credits SUCCESS and nothing else", () => {
    expect(isCredited("SUCCESS")).toBe(true);
    for (const s of [
      "PENDING_DEPOSIT",
      "KNOWN_DEPOSIT_TX",
      "PROCESSING",
      "INCOMPLETE_DEPOSIT",
      "REFUNDED",
      "FAILED",
      "UNKNOWN",
    ] as const) {
      expect(isCredited(s)).toBe(false);
    }
  });

  it("does NOT credit a partial deposit", () => {
    // INCOMPLETE_DEPOSIT means funds landed but under the quote. It is the one
    // state most likely to be mistaken for success, because money really did
    // arrive.
    expect(isCredited("INCOMPLETE_DEPOSIT")).toBe(false);
  });

  it("turns a status it has never seen into UNKNOWN instead of trusting it", () => {
    expect(parseStatus("SETTLED_SOMEHOW")).toBe("UNKNOWN");
    expect(parseStatus(undefined)).toBe("UNKNOWN");
    expect(parseStatus(42)).toBe("UNKNOWN");
    expect(isCredited(parseStatus("SETTLED_SOMEHOW"))).toBe(false);
  });

  it("keeps an UNKNOWN status non-terminal so the screen keeps polling", () => {
    expect(isTerminal("UNKNOWN")).toBe(false);
    expect(isTerminal("PROCESSING")).toBe(false);
    expect(isTerminal("SUCCESS")).toBe(true);
    expect(isTerminal("REFUNDED")).toBe(true);
    expect(isTerminal("FAILED")).toBe(true);
  });
});

describe("parseDeposits", () => {
  it("drops a row it cannot read rather than inventing one", () => {
    const rows = parseDeposits({
      data: [
        {
          status: "SUCCESS",
          depositAddress: "0xabc",
          originAsset: ORIGIN,
          destinationAsset: MONAD_USDC_ASSET_ID,
          amountInFormatted: "2.0",
          amountOutFormatted: "406.72",
        },
        { status: "SUCCESS" },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].amountOutFormatted).toBe("406.72");
  });

  it("returns nothing for a body that is not a list", () => {
    expect(parseDeposits({})).toEqual([]);
    expect(parseDeposits(null)).toEqual([]);
    expect(parseDeposits({ data: "nope" })).toEqual([]);
  });
});

describe("requestUsdcDepositAddress", () => {
  it("refuses to call the API with no key rather than sending an unkeyed request", async () => {
    await expect(
      requestUsdcDepositAddress(
        {
          originAsset: ORIGIN,
          recipient: RECIPIENT,
          refundTo: "hunter.near",
          amount: 1_000_000n,
          slippageTolerance: 100,
          deadline: new Date("2026-12-30T00:00:00.000Z"),
        },
        { appKey: "", fetch: vi.fn() },
      ),
    ).rejects.toThrow(AuroraError);
  });

  it("pins the destination to Monad USDC in the body it sends", async () => {
    const doFetch = vi.fn(async () => ({
      ok: true,
      json: async () => quoteBody(),
    })) as unknown as typeof fetch;

    await requestUsdcDepositAddress(
      {
        originAsset: ORIGIN,
        recipient: RECIPIENT,
        refundTo: "hunter.near",
        amount: 1_000_000n,
        slippageTolerance: 100,
        deadline: new Date("2026-12-30T00:00:00.000Z"),
      },
      { appKey: "test-key", fetch: doFetch },
    );

    const call = (doFetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, { body: string }];
    expect(call[0]).toContain("/api/quote/test-key");
    const sent = JSON.parse(call[1].body) as Record<string, unknown>;
    expect(sent.destinationAsset).toBe(MONAD_USDC_ASSET_ID);
    expect(sent.recipient).toBe(RECIPIENT);
    expect(sent.refundTo).toBe("hunter.near");
    // A bigint would have thrown inside JSON.stringify; it must go as a string.
    expect(sent.amount).toBe("1000000");
  });

  it("surfaces an HTTP failure instead of returning a half-built quote", async () => {
    const doFetch = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await expect(
      requestUsdcDepositAddress(
        {
          originAsset: ORIGIN,
          recipient: RECIPIENT,
          refundTo: "hunter.near",
          amount: 1_000_000n,
          slippageTolerance: 100,
          deadline: new Date("2026-12-30T00:00:00.000Z"),
        },
        { appKey: "test-key", fetch: doFetch },
      ),
    ).rejects.toThrow(/502/);
  });
});

// ---------------------------------------------------------------------------
// Persistent deposit addresses.
//
// Every request/response shape below was measured against the live API on
// 2026-09-22 with a real key, not copied from the docs — which do not state the
// idempotency behaviour at all and spell the chain list differently.
// ---------------------------------------------------------------------------

describe("the deposit chain list", () => {
  it("spells Solana the way the API does, not the way a person would", () => {
    // `solana` is a 400. This is pinned because the obvious guess is wrong and
    // the failure only shows up against the network.
    expect(isDepositChain("sol")).toBe(true);
    expect(isDepositChain("solana")).toBe(false);
  });

  it("carries the evm shortcut, which is the whole point of one address", () => {
    expect(isDepositChain("evm")).toBe(true);
  });

  it("rejects anything not on the API's own list", () => {
    expect(isDepositChain("monad")).toBe(true);
    expect(isDepositChain("ethereum")).toBe(false);
    expect(isDepositChain("")).toBe(false);
  });
});

function addressFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fake = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fake, calls };
}

describe("asking Aurora for a persistent address", () => {
  it("delivers MON by default, so a newcomer can pay their own gas", async () => {
    // The whole point. Someone who funds only through Aurora holds exactly what
    // this delivers; if that were USDC they would hold money they cannot move,
    // because the approval and the swap are both paid in MON.
    const { fake, calls } = addressFetch({
      depositAddress: "0xeb460f216B35889206C95f376a297D72b90C8B15",
      alreadyExists: false,
    });
    await requestPersistentDepositAddress(
      { recipient: RECIPIENT, sender: "player-1", depositChain: "evm" },
      { fetch: fake, appKey: "k" },
    );
    const sent = JSON.parse(String(calls[0]!.init!.body));
    expect(sent.destinationAsset).toBe(MONAD_MON_ASSET_ID);
    // Never a parameter: a deposit that landed on another chain would be gone.
    expect(sent.destinationChain).toBe("monad");
    expect(sent.sender).toBe("player-1");
  });

  it("still delivers the exact USDC kuru.ts trades when asked for USDC", async () => {
    const { fake, calls } = addressFetch({ depositAddress: "0xa" });
    await requestPersistentDepositAddress(
      {
        recipient: RECIPIENT,
        sender: "player-1",
        depositChain: "evm",
        destinationAsset: "USDC",
      },
      { fetch: fake, appKey: "k" },
    );
    expect(JSON.parse(String(calls[0]!.init!.body)).destinationAsset).toBe(
      MONAD_USDC_ASSET_ID,
    );
  });

  it("rejects an asset this app does not deliver", () => {
    expect(isDestinationAsset("MON")).toBe(true);
    expect(isDestinationAsset("USDC")).toBe(true);
    expect(isDestinationAsset("USDT0")).toBe(false);
    expect(isDestinationAsset("")).toBe(false);
  });

  it("puts the key in the path, because Aurora has no auth header", async () => {
    const { fake, calls } = addressFetch({ depositAddress: "0xabc" });
    await requestPersistentDepositAddress(
      { recipient: RECIPIENT, sender: "p", depositChain: "btc" },
      { fetch: fake, appKey: "SECRET" },
    );
    expect(calls[0]!.url).toContain("/api/persistent-deposit-address/SECRET");
  });

  it("refuses a response with no address rather than returning undefined", () => {
    expect(() => parsePersistentAddress({})).toThrow(AuroraError);
    expect(() => parsePersistentAddress({ depositAddress: "" })).toThrow(
      AuroraError,
    );
  });

  it("reports alreadyExists, which means our table and theirs disagreed", () => {
    expect(
      parsePersistentAddress({ depositAddress: "0xa", alreadyExists: true })
        .alreadyExists,
    ).toBe(true);
    // Absent is not true. A missing field must not read as "we already had it".
    expect(
      parsePersistentAddress({ depositAddress: "0xa" }).alreadyExists,
    ).toBe(false);
  });
});

describe("reading what has landed", () => {
  it("asks for one bucket at a time, by address", async () => {
    const { fake, calls } = addressFetch({ deposits: [] });
    await readPersistentDeposits("0xDEP", "success", {
      fetch: fake,
      appKey: "k",
    });
    expect(calls[0]!.url).toContain("/api/persistent-deposit-status/k");
    expect(calls[0]!.url).toContain("address=0xDEP");
    expect(calls[0]!.url).toContain("type=success");
  });

  // The exact payload the live API returned for the first real deposit:
  // 2 USDC sent from Base on 2026-09-22. Pinned verbatim, because the field
  // names are snake_case and an earlier parser looking for `depositAddress`
  // dropped every row without erroring.
  const RECEIVED = {
    deposits: [
      {
        tx_hash:
          "0xc3c58138efde71f871aa3210c903758eda8f21f6ab6981ba4214a92a2257fb4f",
        fromChain: "base",
        asset_id: "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
        decimals: 6,
        amount: "2312039",
        from: "0x7c5090B9456261840CA991a5583dD452FD3409E0",
        created_at: "2026-09-22T18:07:03.609Z",
        deposit_address: "0x85741326Ce25073399AfbAF9D443A6508557C77f",
        recipient: "0xe2ab465839e409c80d1ca4bb4508fea7eb808395",
      },
    ],
  };

  const SUCCESS = {
    deposits: [
      {
        tx_hash:
          "0xe0398f2c85cc30f5e7ba7c9f6835df437a0f8ac82a9fc1c234c227d15150a549",
        destinationChain: "monad",
        asset_id: "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx",
        decimals: 6,
        amount: "2310379",
        created_at: "2026-09-22T18:07:17.815Z",
        deposit_address: "0x85741326Ce25073399AfbAF9D443A6508557C77f",
        recipient: "0xe2ab465839e409c80d1ca4bb4508fea7eb808395",
      },
    ],
  };

  it("reads the row a real deposit actually produced", () => {
    const [row] = parsePersistentDeposits(RECEIVED, "received");
    expect(row!.depositAddress).toBe(
      "0x85741326Ce25073399AfbAF9D443A6508557C77f",
    );
    expect(row!.chain).toBe("base");
    expect(row!.amountFormatted).toBe("2.312039");
    expect(row!.status).toBe("PENDING_DEPOSIT");
  });

  it("reads the delivery, which is a different chain and a smaller amount", () => {
    const [row] = parsePersistentDeposits(SUCCESS, "success");
    expect(row!.chain).toBe("monad");
    // 2.312039 left Base, 2.310379 arrived: Aurora's fee is the difference.
    expect(row!.amountFormatted).toBe("2.310379");
    expect(row!.status).toBe("SUCCESS");
  });

  it("takes the status from the bucket asked for, not from the row", () => {
    const [row] = parsePersistentDeposits(
      { deposits: [{ deposit_address: "0xDEP" }] },
      "failed",
    );
    expect(row!.status).toBe("FAILED");
  });

  it("drops a row it cannot attribute instead of inventing one", () => {
    const rows = parsePersistentDeposits(
      { deposits: [{ amount: "10" }, { deposit_address: "0xDEP" }] },
      "received",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.depositAddress).toBe("0xDEP");
  });

  it("survives a response that is not the shape we expect at all", () => {
    expect(parsePersistentDeposits({}, "received")).toEqual([]);
    expect(parsePersistentDeposits({ deposits: "no" }, "received")).toEqual([]);
    expect(parsePersistentDeposits(null, "received")).toEqual([]);
  });
});

describe("formatting units without a float", () => {
  it("does not lose precision on an amount a double cannot hold", () => {
    // 2^53 is where Number stops counting integers exactly. An 18dp token
    // amount passes that routinely, which is why this is string arithmetic.
    expect(formatUnits("9007199254740993", 0)).toBe("9007199254740993");
    expect(formatUnits("1000000000000000001", 18)).toBe("1.000000000000000001");
  });

  it("pads an amount smaller than one whole unit", () => {
    expect(formatUnits("1", 6)).toBe("0.000001");
    expect(formatUnits("0", 6)).toBe("0");
  });

  it("trims trailing zeros but keeps the whole part", () => {
    expect(formatUnits("2310000", 6)).toBe("2.31");
    expect(formatUnits("2000000", 6)).toBe("2");
  });

  it("refuses input it cannot trust rather than guessing", () => {
    expect(formatUnits("-1", 6)).toBeNull();
    expect(formatUnits("1.5", 6)).toBeNull();
    expect(formatUnits("abc", 6)).toBeNull();
  });
});

describe("what the idempotency key has to survive", () => {
  it("is stable under case, because Aurora compares bytes", async () => {
    // requirePlayer lowercases the wallet it looks up, but a sender that
    // differed only in case would be a different sender to Aurora and would
    // mint a SECOND address for one hunter.
    const seen: string[] = [];
    const fake = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      seen.push(JSON.parse(String(init!.body)).sender);
      return new Response(JSON.stringify({ depositAddress: "0xa" }));
    }) as unknown as typeof fetch;

    for (const wallet of [RECIPIENT, RECIPIENT.toLowerCase()]) {
      await requestPersistentDepositAddress(
        { recipient: wallet, sender: wallet.toLowerCase(), depositChain: "evm" },
        { fetch: fake, appKey: "k" },
      );
    }
    expect(new Set(seen).size).toBe(1);
  });
});
