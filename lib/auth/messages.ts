import {
  CLAIM_ATTEMPT_TYPES,
  HUNT_DOMAIN,
  REGISTRATION_TYPES,
  SESSION_STATEMENT,
  SESSION_TYPES,
} from "./typedData";

// ---------------------------------------------------------------------------
// The exact typed-data payloads the browser signs.
//
// Pure and mera-free so they can be round-tripped against the server's own
// verifiers under vitest — see messages.test.ts. That test is the point of this
// file existing separately from signIn.ts: a field renamed, reordered or
// wrongly typed here does not fail loudly, it recovers a DIFFERENT address, and
// the only symptom is that every player is suddenly told their signature is
// invalid. Signing and verifying in one test catches it before a deploy does.
// ---------------------------------------------------------------------------

export function sessionTypedData(args: {
  wallet: string;
  clientTs: number;
  nonce: string;
}) {
  return {
    domain: HUNT_DOMAIN,
    types: SESSION_TYPES,
    primaryType: "Session" as const,
    message: {
      wallet: args.wallet as `0x${string}`,
      statement: SESSION_STATEMENT,
      clientTs: BigInt(args.clientTs),
      nonce: args.nonce,
    },
  };
}

export function registrationTypedData(args: {
  wallet: string;
  turboUsername: string;
  passkeyCredentialId: string;
  clientTs: number;
  nonce: string;
}) {
  return {
    domain: HUNT_DOMAIN,
    types: REGISTRATION_TYPES,
    primaryType: "Registration" as const,
    message: {
      wallet: args.wallet as `0x${string}`,
      turboUsername: args.turboUsername,
      passkeyCredentialId: args.passkeyCredentialId,
      clientTs: BigInt(args.clientTs),
      nonce: args.nonce,
    },
  };
}

export function claimAttemptTypedData(args: {
  huntId: string;
  lat: string;
  lng: string;
  accuracyM: string;
  clientTs: number;
  nonce: string;
}) {
  return {
    domain: HUNT_DOMAIN,
    types: CLAIM_ATTEMPT_TYPES,
    primaryType: "ClaimAttempt" as const,
    message: {
      huntId: args.huntId,
      lat: args.lat,
      lng: args.lng,
      accuracyM: args.accuracyM,
      clientTs: BigInt(args.clientTs),
      nonce: args.nonce,
    },
  };
}
