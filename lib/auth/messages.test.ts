import { beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { bytesToHex } from "viem";
import {
  MemoryNonceStore,
  verifyClaimSignature,
  verifyRegistrationSignature,
  verifySessionSignature,
} from "./eip712";
import {
  claimAttemptTypedData,
  registrationTypedData,
  sessionTypedData,
} from "./messages";
import { walletFromPrfOutput } from "./derive";

// The wiring test. The browser builds a message here and the server's OWN
// verifier consumes it — not a copy of the verifier, the real exported one. A
// drifted field name or a mistyped uint256 recovers a different address, which
// in production reads as "every player's signature is invalid" with no clue
// where it went wrong. This is the only check that catches it without a phone.

// A passkey-derived wallet, standing in for what Face ID would produce.
const { privateKey } = walletFromPrfOutput(new Uint8Array(32).fill(3));
const account = privateKeyToAccount(bytesToHex(privateKey));

const NOW = new Date("2026-08-28T12:00:00Z");
const clientTs = Math.floor(NOW.getTime() / 1000);

let store: MemoryNonceStore;
beforeEach(() => {
  store = new MemoryNonceStore();
});

describe("session sign-in", () => {
  it("produces a signature the server accepts, recovering the signer", async () => {
    const nonce = "nonce-session-0000000";
    const signature = await account.signTypedData(
      sessionTypedData({ wallet: account.address, clientTs, nonce }),
    );

    const result = await verifySessionSignature(
      {
        wallet: account.address,
        statement:
          "Sign in to EmpowerTours Hunt. This does not authorise a transaction.",
        clientTs: BigInt(clientTs),
        nonce,
        signature,
      },
      { store, now: NOW },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Lowercased, because Player.walletAddress is stored and looked up that way.
      expect(result.address).toBe(account.address.toLowerCase());
    }
  });

  it("is single use — the same signature replayed is refused", async () => {
    const nonce = "nonce-session-replay1";
    const signature = await account.signTypedData(
      sessionTypedData({ wallet: account.address, clientTs, nonce }),
    );
    const payload = {
      wallet: account.address,
      statement:
        "Sign in to EmpowerTours Hunt. This does not authorise a transaction.",
      clientTs: BigInt(clientTs),
      nonce,
      signature,
    };

    expect(
      (await verifySessionSignature(payload, { store, now: NOW })).ok,
    ).toBe(true);
    expect(
      (await verifySessionSignature(payload, { store, now: NOW })).ok,
    ).toBe(false);
  });
});

describe("registration", () => {
  it("produces a signature the server accepts, with the empty turboUsername the client sends", async () => {
    // "" is what signIn.ts puts in both the signed message and the body. If the
    // two ever disagree the recovered address changes and registration 401s.
    const nonce = "nonce-register-000000";
    const args = {
      wallet: account.address,
      turboUsername: "",
      passkeyCredentialId: "Y3JlZGVudGlhbC1pZC1leGFtcGxl",
      clientTs,
      nonce,
    };
    const signature = await account.signTypedData(registrationTypedData(args));

    const result = await verifyRegistrationSignature(
      { ...args, clientTs: BigInt(clientTs), signature },
      { store, now: NOW },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.address).toBe(account.address.toLowerCase());
  });

  it("rejects a body whose credential id differs from the signed one", async () => {
    // The realistic bug: signing one value and posting another. The schema
    // marks passkeyCredentialId UNIQUE, so a mismatch that slipped through
    // would bind someone else's credential to this wallet.
    const nonce = "nonce-register-mismat";
    const signature = await account.signTypedData(
      registrationTypedData({
        wallet: account.address,
        turboUsername: "",
        passkeyCredentialId: "signed-one",
        clientTs,
        nonce,
      }),
    );

    const result = await verifyRegistrationSignature(
      {
        wallet: account.address,
        turboUsername: "",
        passkeyCredentialId: "posted-a-different-one",
        clientTs: BigInt(clientTs),
        nonce,
        signature,
      },
      { store, now: NOW },
    );

    expect(result.ok).toBe(false);
  });
});

describe("claim attempt", () => {
  it("produces a signature the server accepts", async () => {
    const nonce = "nonce-claim-00000000";
    const args = {
      huntId: "hunt_abc123",
      lat: "19.432608",
      lng: "-99.133209",
      accuracyM: "12.5",
      clientTs,
      nonce,
    };
    const signature = await account.signTypedData(claimAttemptTypedData(args));

    const result = await verifyClaimSignature(
      {
        ...args,
        clientTs: BigInt(clientTs),
        signature,
        expectedAddress: account.address.toLowerCase(),
      },
      { store, now: NOW },
    );

    expect(result.ok).toBe(true);
  });

  it("rejects when the coordinates are altered after signing", async () => {
    // lat/lng are signed as the exact characters sent, so a relayed attempt
    // cannot be re-pointed at a different cache.
    const nonce = "nonce-claim-tampered";
    const signature = await account.signTypedData(
      claimAttemptTypedData({
        huntId: "hunt_abc123",
        lat: "19.432608",
        lng: "-99.133209",
        accuracyM: "12.5",
        clientTs,
        nonce,
      }),
    );

    const result = await verifyClaimSignature(
      {
        huntId: "hunt_abc123",
        lat: "19.999999",
        lng: "-99.133209",
        accuracyM: "12.5",
        clientTs: BigInt(clientTs),
        nonce,
        signature,
        expectedAddress: account.address.toLowerCase(),
      },
      { store, now: NOW },
    );

    expect(result.ok).toBe(false);
  });
});
