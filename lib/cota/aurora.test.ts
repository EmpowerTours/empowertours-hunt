import { describe, expect, it, vi } from "vitest";
import {
  AuroraError,
  MONAD_USDC_ADDRESS,
  MONAD_USDC_ASSET_ID,
  isCredited,
  isTerminal,
  parseDepositQuote,
  parseDeposits,
  parseStatus,
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
