import { beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import {
  CLOCK_SKEW_SECONDS,
  COTA_TYPES,
  HUNT_DOMAIN,
  MemoryNonceStore,
  verifyCotaSignature,
  type SignedCota,
} from "@/lib/auth/eip712";
import { leverageX100, usdE6 } from "./scale";

const player = privateKeyToAccount(`0x${"11".repeat(32)}`);
const attacker = privateKeyToAccount(`0x${"22".repeat(32)}`);

const NOW = new Date("2026-09-02T12:00:00Z");
const NOW_SECONDS = BigInt(Math.floor(NOW.getTime() / 1000));

let store: MemoryNonceStore;
let nonceCounter = 0;

beforeEach(() => {
  store = new MemoryNonceStore();
});

function freshNonce(): string {
  nonceCounter += 1;
  return `cota${String(nonceCounter).padStart(20, "0")}`;
}

type Bound = {
  venue: string;
  markets: readonly string[];
  maxNotionalUsdE6: bigint;
  maxLeverageX100: bigint;
  maxDailyLossUsdE6: bigint;
  maxTradesPerDay: number;
  notBefore: bigint;
  notAfter: bigint;
  clientTs: bigint;
  nonce: string;
};

function bound(over: Partial<Bound> = {}): Bound {
  return {
    venue: "perpl",
    markets: ["MON-USDC"],
    maxNotionalUsdE6: usdE6(200),
    maxLeverageX100: leverageX100(3),
    maxDailyLossUsdE6: usdE6(50),
    maxTradesPerDay: 10,
    notBefore: NOW_SECONDS - 3600n,
    notAfter: NOW_SECONDS + 30n * 86400n,
    clientTs: NOW_SECONDS,
    nonce: freshNonce(),
    ...over,
  };
}

async function sign(b: Bound, as = player): Promise<Hex> {
  return as.signTypedData({
    domain: HUNT_DOMAIN,
    types: COTA_TYPES,
    primaryType: "Cota",
    message: { ...b, markets: [...b.markets] },
  });
}

async function verify(
  b: Bound,
  signature: Hex,
  expectedAddress = player.address,
) {
  const payload: SignedCota = { ...b, signature, expectedAddress };
  return verifyCotaSignature(payload, { store, now: NOW });
}

describe("a bound the session player signed", () => {
  it("verifies and returns their address", async () => {
    const b = bound();
    const r = await verify(b, await sign(b));
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.address.toLowerCase()).toBe(player.address.toLowerCase());
  });
});

describe("the signature is bound to the session player", () => {
  it("refuses a bound signed by somebody else", async () => {
    // The whole reason expectedAddress exists: a signature is a bearer
    // credential, so without this one player's ceiling would authorise
    // trading in another's account.
    const b = bound();
    const r = await verify(b, await sign(b, attacker));
    expect(r).toEqual({ ok: false, reason: "wrong_signer" });
  });
});

describe("every ceiling is inside the signature", () => {
  it("refuses a signature lifted onto a raised notional", async () => {
    const b = bound();
    const sig = await sign(b);
    const raised = { ...b, maxNotionalUsdE6: usdE6(5000) };
    expect(await verify(raised, sig)).toEqual({
      ok: false,
      reason: "wrong_signer",
    });
  });

  it("refuses a signature lifted onto raised leverage", async () => {
    const b = bound();
    const sig = await sign(b);
    const raised = { ...b, maxLeverageX100: leverageX100(50) };
    expect(await verify(raised, sig)).toEqual({
      ok: false,
      reason: "wrong_signer",
    });
  });

  it("refuses a signature lifted onto a raised loss ceiling", async () => {
    const b = bound();
    const sig = await sign(b);
    const raised = { ...b, maxDailyLossUsdE6: usdE6(5000) };
    expect(await verify(raised, sig)).toEqual({
      ok: false,
      reason: "wrong_signer",
    });
  });

  it("refuses a signature moved to another market", async () => {
    const b = bound();
    const sig = await sign(b);
    const moved = { ...b, markets: ["BTC-PERP"] };
    expect(await verify(moved, sig)).toEqual({
      ok: false,
      reason: "wrong_signer",
    });
  });

  it("refuses a signature moved to another venue", async () => {
    // Copying spot and trading perps are different agreements about how much
    // can go wrong. A bound signed for one must not authorise the other.
    const b = bound();
    const sig = await sign(b);
    const moved = { ...b, venue: "kuru" };
    expect(await verify(moved, sig)).toEqual({
      ok: false,
      reason: "wrong_signer",
    });
  });

  it("refuses a signature with the expiry pushed out", async () => {
    const b = bound();
    const sig = await sign(b);
    const extended = { ...b, notAfter: b.notAfter + 365n * 86400n };
    expect(await verify(extended, sig)).toEqual({
      ok: false,
      reason: "wrong_signer",
    });
  });
});

describe("replay protection, inherited unchanged", () => {
  it("refuses a nonce that has already been used", async () => {
    const b = bound();
    const sig = await sign(b);
    expect((await verify(b, sig)).ok).toBe(true);
    expect(await verify(b, sig)).toEqual({
      ok: false,
      reason: "nonce_replayed",
    });
  });

  it("refuses a signature older than the clock-skew window", async () => {
    const b = bound({
      clientTs: NOW_SECONDS - BigInt(CLOCK_SKEW_SECONDS) - 1n,
    });
    expect(await verify(b, await sign(b))).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("accepts a signature at the edge of the window", async () => {
    const b = bound({ clientTs: NOW_SECONDS - BigInt(CLOCK_SKEW_SECONDS) });
    expect((await verify(b, await sign(b))).ok).toBe(true);
  });
});

describe("an empty market list is a real state, not a malformed one", () => {
  it("verifies, and authorises nothing", async () => {
    // A signed Cota naming no market is a revocation the player can prove
    // they made. Refusing to verify it would make revocation unprovable.
    const b = bound({ markets: [] });
    expect((await verify(b, await sign(b))).ok).toBe(true);
  });
});
