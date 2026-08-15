import { describe, it, expect, beforeEach } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex, TypedDataDomain } from "viem";
import {
  CLAIM_ATTEMPT_TYPES,
  CLOCK_SKEW_SECONDS,
  HUNT_DOMAIN,
  MemoryNonceStore,
  NONCE_TTL_SECONDS,
  REGISTRATION_TYPES,
  SESSION_STATEMENT,
  SESSION_TYPES,
  verifyClaimSignature,
  verifyRegistrationSignature,
  verifySessionSignature,
  type NonceStore,
} from "./eip712";

const player = privateKeyToAccount(`0x${"11".repeat(32)}`);
const attacker = privateKeyToAccount(`0x${"22".repeat(32)}`);

const NOW = new Date("2026-08-12T12:00:00Z");
const NOW_SECONDS = BigInt(Math.floor(NOW.getTime() / 1000));

let store: MemoryNonceStore;
let nonceCounter = 0;

function freshNonce(): string {
  nonceCounter += 1;
  return `nonce${String(nonceCounter).padStart(20, "0")}`;
}

interface ClaimMessage {
  huntId: string;
  lat: string;
  lng: string;
  accuracyM: string;
  clientTs: bigint;
  nonce: string;
}

function claimMessage(overrides: Partial<ClaimMessage> = {}): ClaimMessage {
  return {
    huntId: "hunt_abc123",
    lat: "19.432608",
    lng: "-99.133209",
    accuracyM: "12.5",
    clientTs: NOW_SECONDS,
    nonce: freshNonce(),
    ...overrides,
  };
}

async function signClaim(
  message: ClaimMessage,
  opts: {
    signer?: typeof player;
    domain?: TypedDataDomain;
  } = {},
): Promise<Hex> {
  const signer = opts.signer ?? player;
  return signer.signTypedData({
    domain: opts.domain ?? HUNT_DOMAIN,
    types: CLAIM_ATTEMPT_TYPES,
    primaryType: "ClaimAttempt",
    message,
  });
}

beforeEach(() => {
  store = new MemoryNonceStore();
});

describe("verifyClaimSignature", () => {
  it("accepts a valid signature and returns the lowercased signer", async () => {
    const message = claimMessage();
    const signature = await signClaim(message);

    const result = await verifyClaimSignature(
      { ...message, signature, expectedAddress: player.address },
      { store, now: NOW },
    );

    expect(result).toEqual({ ok: true, address: player.address.toLowerCase() });
  });

  it("accepts a checksummed expectedAddress", async () => {
    // Player.walletAddress is stored lowercased, but a caller passing the
    // checksummed form must not be locked out on a case mismatch.
    const message = claimMessage();
    const signature = await signClaim(message);

    const result = await verifyClaimSignature(
      { ...message, signature, expectedAddress: player.address },
      { store, now: NOW },
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a signature from the wrong signer", async () => {
    const message = claimMessage();
    const signature = await signClaim(message, { signer: attacker });

    const result = await verifyClaimSignature(
      { ...message, signature, expectedAddress: player.address },
      { store, now: NOW },
    );

    expect(result).toEqual({ ok: false, reason: "wrong_signer" });
  });

  it("rejects a replayed nonce", async () => {
    const message = claimMessage();
    const signature = await signClaim(message);
    const payload = {
      ...message,
      signature,
      expectedAddress: player.address,
    };

    const first = await verifyClaimSignature(payload, { store, now: NOW });
    expect(first.ok).toBe(true);

    // Byte-identical replay: the signature is still valid, which is exactly
    // why the nonce has to be what refuses it.
    const second = await verifyClaimSignature(payload, { store, now: NOW });
    expect(second).toEqual({ ok: false, reason: "nonce_replayed" });
  });

  it("rejects a replay even one second before the signature expires", async () => {
    const message = claimMessage();
    const signature = await signClaim(message);
    const payload = { ...message, signature, expectedAddress: player.address };

    await verifyClaimSignature(payload, { store, now: NOW });

    const nearlyExpired = new Date(
      NOW.getTime() + (CLOCK_SKEW_SECONDS - 1) * 1000,
    );
    const replay = await verifyClaimSignature(payload, {
      store,
      now: nearlyExpired,
    });
    expect(replay).toEqual({ ok: false, reason: "nonce_replayed" });
  });

  it("rejects a tampered lat", async () => {
    const message = claimMessage();
    const signature = await signClaim(message);

    // Signed at one place, submitted as another — the classic "I was standing
    // on the cache" edit. The digest changes, so recovery lands on a stranger.
    const result = await verifyClaimSignature(
      {
        ...message,
        lat: "19.432999",
        signature,
        expectedAddress: player.address,
      },
      { store, now: NOW },
    );

    expect(result).toEqual({ ok: false, reason: "wrong_signer" });
  });

  it("rejects a tampered lng", async () => {
    const message = claimMessage();
    const signature = await signClaim(message);

    const result = await verifyClaimSignature(
      {
        ...message,
        lng: "-99.000000",
        signature,
        expectedAddress: player.address,
      },
      { store, now: NOW },
    );

    expect(result).toEqual({ ok: false, reason: "wrong_signer" });
  });

  it("rejects a tampered huntId", async () => {
    const message = claimMessage();
    const signature = await signClaim(message);

    const result = await verifyClaimSignature(
      {
        ...message,
        huntId: "hunt_other",
        signature,
        expectedAddress: player.address,
      },
      { store, now: NOW },
    );

    expect(result).toEqual({ ok: false, reason: "wrong_signer" });
  });

  it("rejects a timestamp older than the clock-skew window", async () => {
    const stale = NOW_SECONDS - BigInt(CLOCK_SKEW_SECONDS + 1);
    const message = claimMessage({ clientTs: stale });
    const signature = await signClaim(message);

    const result = await verifyClaimSignature(
      { ...message, signature, expectedAddress: player.address },
      { store, now: NOW },
    );

    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a timestamp too far in the future", async () => {
    const future = NOW_SECONDS + BigInt(CLOCK_SKEW_SECONDS + 1);
    const message = claimMessage({ clientTs: future });
    const signature = await signClaim(message);

    const result = await verifyClaimSignature(
      { ...message, signature, expectedAddress: player.address },
      { store, now: NOW },
    );

    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("accepts a timestamp exactly on the skew boundary", async () => {
    const edge = NOW_SECONDS - BigInt(CLOCK_SKEW_SECONDS);
    const message = claimMessage({ clientTs: edge });
    const signature = await signClaim(message);

    const result = await verifyClaimSignature(
      { ...message, signature, expectedAddress: player.address },
      { store, now: NOW },
    );

    expect(result.ok).toBe(true);
  });

  it("rejects a uint256 timestamp large enough to lose precision as a Number", async () => {
    const message = claimMessage({ clientTs: 2n ** 200n });
    const signature = await signClaim(message);

    const result = await verifyClaimSignature(
      { ...message, signature, expectedAddress: player.address },
      { store, now: NOW },
    );

    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a signature made for a different chainId", async () => {
    const message = claimMessage();
    // Same fields, chainId 1 instead of 143. The domain separator is part of
    // the digest, so this must not verify on Monad.
    const signature = await signClaim(message, {
      domain: { ...HUNT_DOMAIN, chainId: 1 },
    });

    const result = await verifyClaimSignature(
      { ...message, signature, expectedAddress: player.address },
      { store, now: NOW },
    );

    expect(result).toEqual({ ok: false, reason: "wrong_signer" });
  });

  it("rejects a signature made for a different domain name", async () => {
    const message = claimMessage();
    const signature = await signClaim(message, {
      domain: { ...HUNT_DOMAIN, name: "SomeOtherDapp" },
    });

    const result = await verifyClaimSignature(
      { ...message, signature, expectedAddress: player.address },
      { store, now: NOW },
    );

    expect(result).toEqual({ ok: false, reason: "wrong_signer" });
  });

  it("rejects a signature made for a different domain version", async () => {
    const message = claimMessage();
    const signature = await signClaim(message, {
      domain: { ...HUNT_DOMAIN, version: "2" },
    });

    const result = await verifyClaimSignature(
      { ...message, signature, expectedAddress: player.address },
      { store, now: NOW },
    );

    expect(result).toEqual({ ok: false, reason: "wrong_signer" });
  });

  it("rejects a malformed signature without touching the nonce store", async () => {
    const message = claimMessage();

    const result = await verifyClaimSignature(
      {
        ...message,
        signature: "0xdeadbeef" as Hex,
        expectedAddress: player.address,
      },
      { store, now: NOW },
    );

    expect(result).toEqual({ ok: false, reason: "malformed" });
    expect(store.size).toBe(0);
  });

  it("rejects a malformed nonce", async () => {
    const message = claimMessage({ nonce: "short" });
    const signature = await signClaim(message);

    const result = await verifyClaimSignature(
      { ...message, signature, expectedAddress: player.address },
      { store, now: NOW },
    );

    expect(result).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a malformed expectedAddress", async () => {
    const message = claimMessage();
    const signature = await signClaim(message);

    const result = await verifyClaimSignature(
      { ...message, signature, expectedAddress: "not-an-address" },
      { store, now: NOW },
    );

    expect(result).toEqual({ ok: false, reason: "malformed" });
  });

  it("does not spend the nonce when the signature is invalid", async () => {
    // Otherwise an unauthenticated attacker who can guess or observe a nonce
    // burns it with garbage and denies the honest request that follows.
    const message = claimMessage();
    const badSignature = await signClaim(message, { signer: attacker });

    const rejected = await verifyClaimSignature(
      { ...message, signature: badSignature, expectedAddress: player.address },
      { store, now: NOW },
    );
    expect(rejected.ok).toBe(false);
    expect(store.size).toBe(0);

    const goodSignature = await signClaim(message);
    const accepted = await verifyClaimSignature(
      { ...message, signature: goodSignature, expectedAddress: player.address },
      { store, now: NOW },
    );
    expect(accepted.ok).toBe(true);
  });

  it("fails CLOSED when the nonce store is unreachable", async () => {
    const broken: NonceStore = {
      consume: () => Promise.reject(new Error("redis down")),
    };
    const message = claimMessage();
    const signature = await signClaim(message);

    const result = await verifyClaimSignature(
      { ...message, signature, expectedAddress: player.address },
      { store: broken, now: NOW },
    );

    expect(result).toEqual({ ok: false, reason: "nonce_store_unavailable" });
  });

  it("scopes nonces per address, so one player cannot burn another's", async () => {
    const nonce = freshNonce();
    const playerMsg = claimMessage({ nonce });
    const attackerMsg = { ...playerMsg };

    const attackerResult = await verifyClaimSignature(
      {
        ...attackerMsg,
        signature: await signClaim(attackerMsg, { signer: attacker }),
        expectedAddress: attacker.address,
      },
      { store, now: NOW },
    );
    expect(attackerResult.ok).toBe(true);

    const playerResult = await verifyClaimSignature(
      {
        ...playerMsg,
        signature: await signClaim(playerMsg),
        expectedAddress: player.address,
      },
      { store, now: NOW },
    );
    expect(playerResult.ok).toBe(true);
  });
});

describe("verifyRegistrationSignature", () => {
  interface RegistrationMessage {
    wallet: `0x${string}`;
    turboUsername: string;
    passkeyCredentialId: string;
    clientTs: bigint;
    nonce: string;
  }

  function registrationMessage(
    overrides: Partial<RegistrationMessage> = {},
  ): RegistrationMessage {
    return {
      wallet: player.address,
      turboUsername: "empowertours",
      passkeyCredentialId: "cred-abc",
      clientTs: NOW_SECONDS,
      nonce: freshNonce(),
      ...overrides,
    };
  }

  function signRegistration(
    message: RegistrationMessage,
    signer = player,
  ): Promise<Hex> {
    return signer.signTypedData({
      domain: HUNT_DOMAIN,
      types: REGISTRATION_TYPES,
      primaryType: "Registration",
      message,
    });
  }

  it("accepts proof of control of the registered wallet", async () => {
    const message = registrationMessage();
    const signature = await signRegistration(message);

    const result = await verifyRegistrationSignature(
      { ...message, signature },
      { store, now: NOW },
    );

    expect(result).toEqual({ ok: true, address: player.address.toLowerCase() });
  });

  it("refuses to register a wallet the caller does not control", async () => {
    // The whole point: an attacker signs with their own key but names the
    // victim's wallet in the payload.
    const message = registrationMessage({ wallet: player.address });
    const signature = await signRegistration(message, attacker);

    const result = await verifyRegistrationSignature(
      { ...message, signature },
      { store, now: NOW },
    );

    expect(result).toEqual({ ok: false, reason: "wrong_signer" });
  });

  it("rejects a swapped turboUsername", async () => {
    // Unsigned, this would let a man-in-the-middle redirect a player's TURBO
    // credit into a cohort account they control.
    const message = registrationMessage();
    const signature = await signRegistration(message);

    const result = await verifyRegistrationSignature(
      { ...message, turboUsername: "attacker", signature },
      { store, now: NOW },
    );

    expect(result).toEqual({ ok: false, reason: "wrong_signer" });
  });

  it("rejects a swapped passkeyCredentialId", async () => {
    const message = registrationMessage();
    const signature = await signRegistration(message);

    const result = await verifyRegistrationSignature(
      { ...message, passkeyCredentialId: "someone-elses-cred", signature },
      { store, now: NOW },
    );

    expect(result).toEqual({ ok: false, reason: "wrong_signer" });
  });

  it("rejects a replayed registration", async () => {
    const message = registrationMessage();
    const signature = await signRegistration(message);

    expect(
      (
        await verifyRegistrationSignature(
          { ...message, signature },
          { store, now: NOW },
        )
      ).ok,
    ).toBe(true);
    expect(
      await verifyRegistrationSignature(
        { ...message, signature },
        { store, now: NOW },
      ),
    ).toEqual({ ok: false, reason: "nonce_replayed" });
  });
});

describe("verifySessionSignature", () => {
  interface SessionMessage {
    wallet: `0x${string}`;
    statement: string;
    clientTs: bigint;
    nonce: string;
  }

  function sessionMessage(
    overrides: Partial<SessionMessage> = {},
  ): SessionMessage {
    return {
      wallet: player.address,
      statement: SESSION_STATEMENT,
      clientTs: NOW_SECONDS,
      nonce: freshNonce(),
      ...overrides,
    };
  }

  function signSession(message: SessionMessage, signer = player): Promise<Hex> {
    return signer.signTypedData({
      domain: HUNT_DOMAIN,
      types: SESSION_TYPES,
      primaryType: "Session",
      message,
    });
  }

  it("accepts a valid login", async () => {
    const message = sessionMessage();
    const signature = await signSession(message);

    const result = await verifySessionSignature(
      { ...message, signature },
      { store, now: NOW },
    );

    expect(result).toEqual({ ok: true, address: player.address.toLowerCase() });
  });

  it("rejects a signature over a different statement", async () => {
    // Stops a signature harvested by some other dapp from doubling as a login.
    const message = sessionMessage({ statement: "gm" });
    const signature = await signSession(message);

    const result = await verifySessionSignature(
      { ...message, signature },
      { store, now: NOW },
    );

    expect(result).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a replayed login", async () => {
    const message = sessionMessage();
    const signature = await signSession(message);

    expect(
      (
        await verifySessionSignature(
          { ...message, signature },
          { store, now: NOW },
        )
      ).ok,
    ).toBe(true);
    expect(
      await verifySessionSignature(
        { ...message, signature },
        { store, now: NOW },
      ),
    ).toEqual({ ok: false, reason: "nonce_replayed" });
  });

  it("does not let a login nonce be reused as a claim nonce", async () => {
    const nonce = freshNonce();
    const login = sessionMessage({ nonce });
    await verifySessionSignature(
      { ...login, signature: await signSession(login) },
      { store, now: NOW },
    );

    // Different primaryType, so a different nonce record. Sharing them would
    // make a login a way to invalidate a pending claim.
    const claim = claimMessage({ nonce });
    const result = await verifyClaimSignature(
      {
        ...claim,
        signature: await signClaim(claim),
        expectedAddress: player.address,
      },
      { store, now: NOW },
    );
    expect(result.ok).toBe(true);
  });
});

describe("MemoryNonceStore", () => {
  it("is bounded", async () => {
    const bounded = new MemoryNonceStore(100);
    for (let i = 0; i < 5_000; i += 1) {
      await bounded.consume(`k${i}`, NONCE_TTL_SECONDS);
    }
    expect(bounded.size).toBeLessThanOrEqual(100);
  });

  it("reports a fresh key once and only once", async () => {
    const s = new MemoryNonceStore();
    expect(await s.consume("k", NONCE_TTL_SECONDS)).toBe(true);
    expect(await s.consume("k", NONCE_TTL_SECONDS)).toBe(false);
  });
});
