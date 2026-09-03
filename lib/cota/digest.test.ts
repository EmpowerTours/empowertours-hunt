import { describe, expect, it } from "vitest";
import { cotaDigest, type CotaMessage } from "./typedData";
import { leverageX100, usdE6 } from "./scale";

function message(over: Partial<CotaMessage> = {}): CotaMessage {
  return {
    venue: "perpl",
    markets: ["BTC"],
    maxNotionalUsdE6: usdE6(200),
    maxLeverageX100: leverageX100(3),
    maxDailyLossUsdE6: usdE6(50),
    maxTradesPerDay: 10,
    notBefore: 1_756_000_000n,
    notAfter: 1_760_000_000n,
    clientTs: 1_756_000_100n,
    nonce: "n".repeat(20),
    ...over,
  };
}

describe("the digest identifies the agreement", () => {
  it("is stable for the same message", () => {
    expect(cotaDigest(message())).toBe(cotaDigest(message()));
  });

  it("is a 32-byte hash", () => {
    expect(cotaDigest(message())).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("every signed field moves the digest", () => {
  // This is the property Cota.digest's UNIQUE constraint rests on. If any
  // field failed to move it, two different agreements would collide — and one
  // could be revoked while the other stayed live, which is precisely the
  // failure the unique column exists to prevent.
  const base = cotaDigest(message());

  const variants: Array<[string, CotaMessage]> = [
    // COTA_VENUES currently has one member, so the type alone rules this out
    // and the cast is what lets the property be tested at all. It is worth
    // testing anyway: adding a second venue is described as a deliberate act,
    // and this is the assertion that must still hold on the day someone does.
    [
      "venue",
      { ...message(), venue: "kuru" } as unknown as CotaMessage,
    ],
    ["markets", message({ markets: ["ETH"] })],
    ["markets length", message({ markets: ["BTC", "ETH"] })],
    ["empty markets", message({ markets: [] })],
    ["maxNotionalUsdE6", message({ maxNotionalUsdE6: usdE6(201) })],
    ["maxLeverageX100", message({ maxLeverageX100: leverageX100(3.01) })],
    ["maxDailyLossUsdE6", message({ maxDailyLossUsdE6: usdE6(51) })],
    ["maxTradesPerDay", message({ maxTradesPerDay: 11 })],
    ["notBefore", message({ notBefore: 1_756_000_001n })],
    ["notAfter", message({ notAfter: 1_760_000_001n })],
    ["clientTs", message({ clientTs: 1_756_000_101n })],
    ["nonce", message({ nonce: `${"n".repeat(19)}x` })],
  ];

  for (const [field, variant] of variants) {
    it(`changes when ${field} changes`, () => {
      expect(cotaDigest(variant)).not.toBe(base);
    });
  }

  it("produces a distinct digest for all of them", () => {
    const all = new Set([base, ...variants.map(([, m]) => cotaDigest(m))]);
    expect(all.size).toBe(variants.length + 1);
  });
});

describe("market order is part of the agreement", () => {
  it("distinguishes the same markets listed differently", () => {
    // EIP-712 hashes an array in order, so ["BTC","ETH"] and ["ETH","BTC"] are
    // different messages. Worth pinning: a UI that sorted the list before
    // signing but not before verifying would produce a signature that fails
    // as "wrong_signer" with nothing obviously wrong on screen.
    const a = cotaDigest(message({ markets: ["BTC", "ETH"] }));
    const b = cotaDigest(message({ markets: ["ETH", "BTC"] }));
    expect(a).not.toBe(b);
  });
});
