import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { getAddress, hashTypedData, hexToBytes } from "viem";
import {
  b64urlPublicKey,
  BUILDER_ID,
  BUILDER_NAME,
  generateApiKeypair,
  PayloadMismatch,
  proofOfPossession,
  SCOPE_READ_TRADE,
  verifyPayloadMatchesTerms,
  type EnrollTerms,
  type PerpPayload,
} from "./enroll";

const ORIGIN = "https://mandate.empowertours.xyz";
const ADDRESS = getAddress("0x7d5be2e5b7c6f4f9b4d1b2c3d4e5f60718290853");

// A fixed keypair so the vectors are stable.
const KP = generateApiKeypair();

function termsFor(over: Partial<EnrollTerms> = {}): EnrollTerms {
  return {
    chainId: 143,
    address: ADDRESS,
    publicKey: KP.publicKeyHex,
    scopeMask: SCOPE_READ_TRADE,
    label: "cota-test",
    builderId: BUILDER_ID,
    maxBuilderFeePer100k: 20,
    expiresAt: 1_800_000_000_000,
    ...over,
  };
}

// A well-formed payload the venue would return for these terms.
function payloadFor(
  terms: EnrollTerms,
  messageOver: Record<string, unknown> = {},
): PerpPayload {
  return {
    domain: { name: "Perpl", version: "1", chainId: terms.chainId },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
      ],
      ApiKey: [
        { name: "signer", type: "address" },
        { name: "builderId", type: "string" },
        { name: "maxBuilderFeePer100K", type: "string" },
        { name: "scope", type: "string" },
        { name: "label", type: "string" },
        { name: "origin", type: "string" },
        { name: "publicKey", type: "string" },
        { name: "statement", type: "string" },
      ],
    },
    primaryType: "ApiKey",
    message: {
      signer: terms.address,
      builderId: String(terms.builderId),
      maxBuilderFeePer100K: String(terms.maxBuilderFeePer100k),
      scope: String(terms.scopeMask),
      label: terms.label,
      origin: ORIGIN,
      publicKey: b64urlPublicKey(terms.publicKey),
      statement:
        `Authorize a ${BUILDER_NAME} trading key under builder code ` +
        `${terms.builderId} on Perpl.`,
      ...messageOver,
    },
  };
}

describe("b64urlPublicKey", () => {
  it("is url-safe and unpadded", () => {
    const out = b64urlPublicKey("0x" + "ff".repeat(32));
    expect(out).not.toMatch(/[+/=]/);
    // 32 bytes -> 43 base64url chars (no padding).
    expect(out).toHaveLength(43);
  });
});

describe("generateApiKeypair", () => {
  it("returns a 32-byte private and public key as 0x-hex", () => {
    const { secretHex, publicKeyHex } = generateApiKeypair();
    expect(secretHex).toMatch(/^0x[0-9a-f]{64}$/);
    expect(publicKeyHex).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("proofOfPossession", () => {
  it("signs the exact EIP-712 digest with the enrolled key", () => {
    const terms = termsFor();
    const payload = payloadFor(terms);
    const pop = proofOfPossession(payload, KP.secretHex);

    const digest = hashTypedData({
      domain: payload.domain,
      types: payload.types,
      primaryType: payload.primaryType,
      message: payload.message,
    });
    const ok = ed25519.verify(
      hexToBytes(pop),
      hexToBytes(digest),
      hexToBytes(KP.publicKeyHex),
    );
    expect(ok).toBe(true);
  });

  it("a proof from a different key does not verify", () => {
    const terms = termsFor();
    const payload = payloadFor(terms);
    const other = generateApiKeypair();
    const pop = proofOfPossession(payload, other.secretHex);
    const digest = hashTypedData({
      domain: payload.domain,
      types: payload.types,
      primaryType: payload.primaryType,
      message: payload.message,
    });
    const ok = ed25519.verify(
      hexToBytes(pop),
      hexToBytes(digest),
      hexToBytes(KP.publicKeyHex),
    );
    expect(ok).toBe(false);
  });
});

describe("verifyPayloadMatchesTerms", () => {
  it("passes a payload that names exactly the requested terms", () => {
    const terms = termsFor();
    expect(() =>
      verifyPayloadMatchesTerms(payloadFor(terms), terms, ORIGIN),
    ).not.toThrow();
  });

  // Each machine-enforced field, tampered one at a time, must be rejected.
  const tampers: Array<[string, Record<string, unknown>]> = [
    ["builderId", { builderId: "8" }],
    ["fee ceiling", { maxBuilderFeePer100K: "100" }],
    ["scope", { scope: "2" }],
    ["label", { label: "something-else" }],
    ["origin", { origin: "https://evil.example" }],
    ["public key", { publicKey: b64urlPublicKey("0x" + "aa".repeat(32)) }],
    [
      "signer",
      { signer: getAddress("0x000000000000000000000000000000000000dead") },
    ],
    ["statement (builder code)", { statement: `A ${BUILDER_NAME} key.` }],
    ["statement (builder name)", { statement: `builder code ${BUILDER_ID}.` }],
  ];

  for (const [name, over] of tampers) {
    it(`rejects a tampered ${name}`, () => {
      const terms = termsFor();
      expect(() =>
        verifyPayloadMatchesTerms(payloadFor(terms, over), terms, ORIGIN),
      ).toThrow(PayloadMismatch);
    });
  }

  it("rejects a payload fetched under a different origin", () => {
    const terms = termsFor();
    // The payload was minted for the real origin, but we verify against another.
    expect(() =>
      verifyPayloadMatchesTerms(payloadFor(terms), terms, "https://x.example"),
    ).toThrow(PayloadMismatch);
  });
});
