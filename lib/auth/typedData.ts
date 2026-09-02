// ---------------------------------------------------------------------------
// EIP-712 typed data — the exact shapes a signature is taken over.
//
// Split out of eip712.ts so the BROWSER can import them. eip712.ts pulls in the
// Redis-backed nonce store, and a client bundle must not carry that. Signer and
// verifier reading one definition is the point: two copies of a struct
// definition drift, and a drifted struct recovers a different address, which
// presents as "every signature is suddenly invalid" with no obvious cause.
//
// Nothing here imports anything. Keep it that way.
// ---------------------------------------------------------------------------


/**
 * Fixed per AGENTS.md. chainId 143 is Monad mainnet; it is part of the domain
 * separator, so a signature produced for any other chain will not verify here.
 * No verifyingContract: nothing on-chain consumes these, and inventing an
 * address would only create a second thing that must be kept in sync.
 */
export const HUNT_DOMAIN = {
  name: "EmpowerToursHunt",
  version: "1",
  chainId: 143,
} as const;

export const CLAIM_ATTEMPT_TYPES = {
  ClaimAttempt: [
    { name: "huntId", type: "string" },
    // lat/lng/accuracyM are strings, not fixed-point ints, so the signed bytes
    // are exactly the characters the client sent. A float re-encoded on the way
    // to the hasher is a signature that verifies over a value nobody signed.
    { name: "lat", type: "string" },
    { name: "lng", type: "string" },
    { name: "accuracyM", type: "string" },
    { name: "clientTs", type: "uint256" },
    { name: "nonce", type: "string" },
  ],
} as const;

export const REGISTRATION_TYPES = {
  Registration: [
    { name: "wallet", type: "address" },
    // Both optional fields are inside the signature. turboUsername decides
    // which cohort the credit lands in and passkeyCredentialId is UNIQUE in the
    // schema, so an unsigned one would let a man-in-the-middle either redirect
    // a player's credit or burn another player's credential id.
    { name: "turboUsername", type: "string" },
    { name: "passkeyCredentialId", type: "string" },
    { name: "clientTs", type: "uint256" },
    { name: "nonce", type: "string" },
  ],
} as const;

export const SESSION_TYPES = {
  Session: [
    { name: "wallet", type: "address" },
    { name: "statement", type: "string" },
    { name: "clientTs", type: "uint256" },
    { name: "nonce", type: "string" },
  ],
} as const;

/**
 * Pinned string inside every login signature. It makes a login signature
 * unmistakable to a human reading a wallet prompt, and stops a signature
 * harvested by some unrelated dapp from doubling as a session here.
 */
export const SESSION_STATEMENT =
  "Sign in to EmpowerTours Hunt. This does not authorise a transaction.";
