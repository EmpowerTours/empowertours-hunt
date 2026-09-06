import { ed25519 } from "@noble/curves/ed25519.js";
import {
  bytesToHex,
  getAddress,
  hashTypedData,
  hexToBytes,
  type Hex,
  type TypedDataDomain,
} from "viem";

// ---------------------------------------------------------------------------
// Enrolling a builder-bound Perpl API key, entirely in the browser.
//
// A faithful port of mandate/src/enrollment.py, with one deliberate difference:
// nothing here is ever stored server-side. The Ed25519 private key is generated
// on the device, signs the proof-of-possession on the device, and is saved only
// in this browser. Hunt is the *verifier*, never the key-holder — so a Hunt
// breach exposes no trading authority, no matter how many users enrol.
//
// The two-signature handshake (unchanged from Perpl's design):
//   1. The user's passkey wallet signs the EIP-712 payload  -> proves account
//      ownership and authorises our builder-fee ceiling.
//   2. The Ed25519 key signs the SAME EIP-712 digest        -> proves we hold
//      the private key being enrolled.
// Both cover the identical 32 bytes: keccak(0x19 ‖ 0x01 ‖ domain ‖ struct),
// which is exactly viem's hashTypedData of the payload.
//
// The key can open and close positions but can NEVER withdraw — Perpl enforces
// that at the venue — so even a fully compromised device is bounded to trading.
// ---------------------------------------------------------------------------

export const SCOPE_READ = 1;
export const SCOPE_TRADE = 2;
export const SCOPE_READ_TRADE = 3;
export const BUILDER_ID = 9;
export const BUILDER_NAME = "Mandate";
export const KEY_LIFETIME_DAYS = 90;
export const CHAIN_ID = 143;
/** 20 per_100k = 2 bps = 0.02% — a modest, disclosed ceiling. Max is 100. */
export const DEFAULT_BUILDER_FEE_PER_100K = 20;

const STORAGE_KEY = "cota.enrollment.v1";

export class PayloadMismatch extends Error {}

export interface EnrollTerms {
  chainId: number;
  address: string;
  /** Raw 32-byte Ed25519 public key, 0x-hex. */
  publicKey: string;
  scopeMask: number;
  label: string;
  builderId: number;
  maxBuilderFeePer100k: number;
  /** Key expiry, in milliseconds (Perpl's unit). */
  expiresAt: number;
}

/** The EIP-712 payload Perpl returns for the wallet to sign. Treated opaquely. */
export interface PerpPayload {
  domain: TypedDataDomain;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

/** What we keep after a successful enrolment — on THIS device only. */
export interface EnrolledKey {
  apiKey: string;
  /** Ed25519 private key, 0x-hex. Never leaves the browser. */
  secretHex: string;
  account: string;
  builderId?: number;
  builderName?: string;
  maxBuilderFeePer100k?: number;
  scopeMask: number;
  origin?: string;
  /** Milliseconds. */
  expiresAt: number;
}

/**
 * A fresh Ed25519 pair. Public half as raw 32 bytes, 0x-hex — matching
 * generate_api_keypair() in enrollment.py exactly.
 */
export function generateApiKeypair(): {
  secretHex: Hex;
  publicKeyHex: Hex;
} {
  const sk = ed25519.utils.randomSecretKey();
  const pk = ed25519.getPublicKey(sk);
  return { secretHex: bytesToHex(sk), publicKeyHex: bytesToHex(pk) };
}

/** base64url(raw public key bytes), no padding — matches _b64url_public_key. */
export function b64urlPublicKey(publicKeyHex: string): string {
  const raw = hexToBytes(publicKeyHex as Hex);
  let binary = "";
  for (const b of raw) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Build the enrolment terms. Expiry is KEY_LIFETIME_DAYS out, in ms. */
export function buildTerms(opts: {
  address: string;
  publicKeyHex: string;
  label: string;
  maxBuilderFeePer100k?: number;
  scopeMask?: number;
}): EnrollTerms {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    chainId: CHAIN_ID,
    address: getAddress(opts.address),
    publicKey: opts.publicKeyHex,
    scopeMask: opts.scopeMask ?? SCOPE_READ_TRADE,
    label: opts.label,
    builderId: BUILDER_ID,
    maxBuilderFeePer100k:
      opts.maxBuilderFeePer100k ?? DEFAULT_BUILDER_FEE_PER_100K,
    expiresAt: (nowSec + KEY_LIFETIME_DAYS * 86_400) * 1000,
  };
}

/** The exact body `/v1/api-key/payload` expects (snake_case, like Perpl's). */
export function toPayloadRequest(terms: EnrollTerms): Record<string, unknown> {
  return {
    chain_id: terms.chainId,
    address: getAddress(terms.address),
    public_key: terms.publicKey,
    scope_mask: terms.scopeMask,
    label: terms.label,
    builder_id: terms.builderId,
    max_builder_fee_per_100k: terms.maxBuilderFeePer100k,
    expires_at: terms.expiresAt,
  };
}

/**
 * Check the payload before the wallet is ever asked to sign it — a port of
 * verify_payload_matches_terms. Every machine-enforced term (builder code, fee
 * ceiling, scope, origin, the public key being enrolled) is a field of the same
 * signed struct, so a payload that says something other than what we asked for
 * is caught here rather than trusted. Throws PayloadMismatch on any surprise.
 */
export function verifyPayloadMatchesTerms(
  payload: PerpPayload,
  terms: EnrollTerms,
  origin: string,
): void {
  const m = payload.message ?? {};
  const expected: Record<string, string> = {
    builderId: String(terms.builderId),
    maxBuilderFeePer100K: String(terms.maxBuilderFeePer100k),
    scope: String(terms.scopeMask),
    label: terms.label,
    origin,
    publicKey: b64urlPublicKey(terms.publicKey),
  };
  for (const [field, want] of Object.entries(expected)) {
    const got = m[field];
    if (String(got) !== want) {
      throw new PayloadMismatch(
        `payload ${field}=${JSON.stringify(got)}, requested ${JSON.stringify(want)}; ` +
          "the user would be signing terms we did not ask for",
      );
    }
  }

  const signer = String(m.signer ?? "");
  const zero = "0x0000000000000000000000000000000000000000";
  if (getAddress(signer || zero) !== getAddress(terms.address)) {
    throw new PayloadMismatch(
      `payload is for ${signer}, terms are for ${terms.address}`,
    );
  }

  const statement = String(m.statement ?? "");
  if (!statement.includes(`builder code ${terms.builderId}`)) {
    throw new PayloadMismatch(
      `statement does not name builder code ${terms.builderId}: ${JSON.stringify(statement)}`,
    );
  }
  if (!statement.includes(BUILDER_NAME)) {
    throw new PayloadMismatch(
      `statement does not name ${JSON.stringify(BUILDER_NAME)}; has Perpl renamed ` +
        `the builder? statement was: ${JSON.stringify(statement)}`,
    );
  }
}

/**
 * Ed25519 proof-of-possession over the EIP-712 digest of the payload, 0x-hex.
 * The digest is the same 32 bytes the wallet signs, so one struct carries both
 * consents.
 */
export function proofOfPossession(
  payload: PerpPayload,
  secretHex: string,
): Hex {
  const digest = hashTypedData({
    domain: payload.domain,
    types: payload.types,
    primaryType: payload.primaryType,
    message: payload.message,
  });
  const sig = ed25519.sign(hexToBytes(digest), hexToBytes(secretHex as Hex));
  return bytesToHex(sig);
}

// ------------------------------------------------------------ device storage

/** Load this device's enrolled key, or null. Never throws. */
export function loadEnrollment(): EnrolledKey | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as EnrolledKey;
  } catch {
    return null;
  }
}

/** Save this device's enrolled key. Never throws. */
export function saveEnrollment(key: EnrolledKey): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(key));
  } catch {
    /* private mode / storage disabled — the caller shows the key was made */
  }
}

/** Forget this device's enrolled key. */
export function clearEnrollment(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}

/** True when an enrolled key exists and has not expired. */
export function isLive(key: EnrolledKey | null): key is EnrolledKey {
  return key !== null && key.expiresAt > Date.now();
}
