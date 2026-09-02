import {
  recoverTypedDataAddress,
  isAddress,
  isHex,
  type Hex,
  type RecoverTypedDataAddressParameters,
} from "viem";
import { getRedis } from "@/lib/ratelimit";

// ---------------------------------------------------------------------------
// EIP-712 signed intents.
//
// This is a security fix, not a feature. Before it, possession of the session
// cookie was sufficient to claim, and the Privy session cookie is verifiably
// NOT HttpOnly (the browser SDK reads it), so any XSS on the origin yields a
// replayable bearer token. It also meant a cross-site POST could be made to
// carry the victim's cookie.
//
// Requiring a signature over the exact intent fixes both at once:
//
//   * a stolen cookie cannot claim, because the attacker cannot produce a
//     signature from the player's key;
//   * a cross-site request cannot claim, for the same reason — CSRF gives an
//     attacker the ambient cookie, never the signing key;
//   * and every accepted attempt is non-repudiable, which is what lets a
//     disputed payout be settled by replaying the record rather than by
//     someone's judgement.
//
// A signature alone is not enough: it is a bearer credential too, just a
// longer-lived one. Three things bound it.
//
//   1. `nonce` is single-use. First use wins; a replay is refused.
//   2. `clientTs` must sit inside the clock-skew window, so a captured
//      signature has a bounded lifetime even if the nonce store is lost.
//   3. The recovered address must equal the session player's wallet. This is
//      what makes a wrong domain or wrong chainId a rejection: signing over a
//      different domain separator recovers a DIFFERENT address, and that
//      address is not the session player's, so it fails. Drop the expected
//      address check and cross-domain replay comes straight back.
// ---------------------------------------------------------------------------
import {
  CLAIM_ATTEMPT_TYPES,
  HUNT_DOMAIN,
  REGISTRATION_TYPES,
  SESSION_STATEMENT,
  SESSION_TYPES,
} from "./typedData";
import { COTA_TYPES } from "@/lib/cota/typedData";

// Re-exported so this module stays the one import site for anything server-side.
export {
  CLAIM_ATTEMPT_TYPES,
  COTA_TYPES,
  HUNT_DOMAIN,
  REGISTRATION_TYPES,
  SESSION_STATEMENT,
  SESSION_TYPES,
};

/**
 * Accepted clock skew, seconds. Matches Hunt.maxClockSkewSeconds' default so a
 * signature and the position inside it expire together.
 */
export const CLOCK_SKEW_SECONDS = 120;

/**
 * Nonce retention. A message is accepted while clientTs sits anywhere in
 * [now - skew, now + skew], so the newest usable signature is one stamped
 * skew seconds in the future, and it stays usable for skew seconds after that.
 * The nonce record therefore has to outlive the acceptance window itself —
 * 2 x skew — or a replay could arrive after its own nonce had expired.
 */
export const NONCE_TTL_SECONDS = CLOCK_SKEW_SECONDS * 2;

// --- Result type -----------------------------------------------------------
//
// These functions return a result rather than throwing AuthError. AuthError
// lives in lib/auth/index.ts, and having this module import it back would make
// the module graph circular. lib/auth/index.ts converts a failure into an
// AuthError at the boundary, which is also what keeps every rejection reason
// out of the HTTP response by default.

export type VerifyFailure =
  | "malformed"
  | "expired"
  | "bad_signature"
  | "wrong_signer"
  | "nonce_replayed"
  | "nonce_store_unavailable";

export type VerifyResult =
  { ok: true; address: string } | { ok: false; reason: VerifyFailure };

export interface SignedClaim {
  huntId: string;
  lat: string;
  lng: string;
  accuracyM: string;
  /** Unix SECONDS. */
  clientTs: bigint;
  nonce: string;
  signature: Hex;
  /** The session player's wallet. The recovered address must equal this. */
  expectedAddress: string;
}

export interface SignedRegistration {
  wallet: string;
  turboUsername: string;
  passkeyCredentialId: string;
  clientTs: bigint;
  nonce: string;
  signature: Hex;
}

export interface SignedSession {
  wallet: string;
  statement: string;
  clientTs: bigint;
  nonce: string;
  signature: Hex;
}

export interface VerifyOptions {
  /** Injected in tests. Production uses Redis, or a bounded memory store. */
  store?: NonceStore;
  /** Injected in tests. */
  now?: Date;
}

// --- Nonce store -----------------------------------------------------------

export interface NonceStore {
  /**
   * Record `key` as used. Resolves true only if it was previously unused.
   * MUST throw rather than resolve false when the backend is unreachable —
   * a backend outage that reads as "already used" would deny every honest
   * request, and one that reads as "unused" would silently disable replay
   * protection.
   */
  consume(key: string, ttlSeconds: number): Promise<boolean>;
}

class RedisNonceStore implements NonceStore {
  async consume(key: string, ttlSeconds: number): Promise<boolean> {
    const redis = getRedis();
    if (!redis) throw new Error("redis unavailable");
    // SET key value NX EX ttl — atomic test-and-set. Returns "OK" on a fresh
    // key and null when the key already existed. A GET-then-SET here would let
    // two concurrent replays of the same signature both observe "unused".
    const written = await redis.set(key, 1, { nx: true, ex: ttlSeconds });
    return written === "OK";
  }
}

/**
 * Bounded fallback for local development and for deployments with no Redis.
 *
 * Single-instance only, and therefore NOT a replay control across a horizontal
 * deploy — see requireRedisNonceStore() below, which is what stops this from
 * being used where it would be a hole.
 */
export class MemoryNonceStore implements NonceStore {
  private readonly used = new Map<string, number>();

  constructor(private readonly maxEntries = 50_000) {}

  get size(): number {
    return this.used.size;
  }

  clear(): void {
    this.used.clear();
  }

  async consume(key: string, ttlSeconds: number): Promise<boolean> {
    const now = Date.now();
    const expiresAt = this.used.get(key);
    if (expiresAt !== undefined && expiresAt > now) return false;

    if (this.used.size >= this.maxEntries) {
      for (const [k, exp] of this.used) {
        if (exp <= now) this.used.delete(k);
      }
      // Still full: drop the oldest insertion. Entries are inserted with a
      // fixed TTL, so insertion order is expiry order and the oldest is the
      // closest to expiring anyway.
      while (this.used.size >= this.maxEntries) {
        const oldest = this.used.keys().next();
        if (oldest.done) break;
        this.used.delete(oldest.value);
      }
    }

    this.used.delete(key);
    this.used.set(key, now + ttlSeconds * 1000);
    return true;
  }
}

const memoryNonceStore = new MemoryNonceStore();

/**
 * Redis when configured, otherwise the bounded memory store.
 *
 * In production the memory store is a footgun — two instances each accept the
 * same nonce once — so a production deployment without Redis is refused rather
 * than quietly downgraded.
 */
export function defaultNonceStore(): NonceStore {
  if (getRedis()) return new RedisNonceStore();
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "UPSTASH_REDIS_REST_URL is required in production: the in-memory nonce " +
        "store cannot prevent replay across instances",
    );
  }
  return memoryNonceStore;
}

// --- Shared verification ---------------------------------------------------

const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;

function nonceKey(primaryType: string, address: string, nonce: string): string {
  // Scoped by address so an attacker cannot pre-burn a nonce another player is
  // about to use, and so two players choosing the same random nonce do not
  // collide. Scoped by primaryType so a login nonce and a claim nonce are
  // distinct records.
  return `hunt:nonce:${primaryType}:${address}:${nonce}`;
}

function timestampOk(clientTs: bigint, now: Date): boolean {
  if (clientTs <= 0n) return false;
  // Bound before converting: a uint256 from the wire can exceed Number's safe
  // range, and Number(huge) silently loses precision.
  if (clientTs > 100_000_000_000n) return false;
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const delta = Math.abs(nowSeconds - Number(clientTs));
  // Reject-by-default form: a NaN delta fails `<=` and therefore rejects.
  return delta <= CLOCK_SKEW_SECONDS;
}

async function recoverAndCheck(args: {
  /** Names the nonce namespace, and must match typedData.primaryType. */
  primaryType: string;
  /** Built by the caller so viem infers the message shape from the literal. */
  typedData: RecoverTypedDataAddressParameters;
  signature: Hex;
  nonce: string;
  clientTs: bigint;
  expectedAddress: string;
  opts?: VerifyOptions;
}): Promise<VerifyResult> {
  const now = args.opts?.now ?? new Date();

  if (!isHex(args.signature) || args.signature.length < 132) {
    return { ok: false, reason: "malformed" };
  }
  if (!NONCE_RE.test(args.nonce)) {
    return { ok: false, reason: "malformed" };
  }
  if (!isAddress(args.expectedAddress, { strict: false })) {
    return { ok: false, reason: "malformed" };
  }

  // Cheap and local, so it runs before the elliptic-curve recovery.
  if (!timestampOk(args.clientTs, now)) {
    return { ok: false, reason: "expired" };
  }

  let recovered: string;
  try {
    recovered = await recoverTypedDataAddress(args.typedData);
  } catch {
    return { ok: false, reason: "bad_signature" };
  }

  const address = recovered.toLowerCase();
  if (address !== args.expectedAddress.toLowerCase()) {
    // Also the path a wrong chainId, a wrong domain name/version, or a tampered
    // field lands on: any of them changes the digest, so recovery yields some
    // unrelated address rather than an error.
    return { ok: false, reason: "wrong_signer" };
  }

  // Only now, with the signature proven, is the nonce spent. Consuming earlier
  // would let an unauthenticated caller burn nonces with garbage signatures.
  let store: NonceStore;
  try {
    store = args.opts?.store ?? defaultNonceStore();
  } catch {
    return { ok: false, reason: "nonce_store_unavailable" };
  }

  let fresh: boolean;
  try {
    fresh = await store.consume(
      nonceKey(args.primaryType, address, args.nonce),
      NONCE_TTL_SECONDS,
    );
  } catch {
    // Fail closed. Without a working nonce store there is no replay protection,
    // and these signatures authorise money.
    return { ok: false, reason: "nonce_store_unavailable" };
  }
  if (!fresh) return { ok: false, reason: "nonce_replayed" };

  return { ok: true, address };
}

/**
 * Verify a signed claim or spawn collect. Returns the recovered, lowercased
 * address on success.
 */
export function verifyClaimSignature(
  payload: SignedClaim,
  opts?: VerifyOptions,
): Promise<VerifyResult> {
  return recoverAndCheck({
    primaryType: "ClaimAttempt",
    typedData: {
      domain: HUNT_DOMAIN,
      types: CLAIM_ATTEMPT_TYPES,
      primaryType: "ClaimAttempt",
      message: {
        huntId: payload.huntId,
        lat: payload.lat,
        lng: payload.lng,
        accuracyM: payload.accuracyM,
        clientTs: payload.clientTs,
        nonce: payload.nonce,
      },
      signature: payload.signature,
    },
    signature: payload.signature,
    nonce: payload.nonce,
    clientTs: payload.clientTs,
    expectedAddress: payload.expectedAddress,
    opts,
  });
}

/**
 * Verify proof of wallet control at registration.
 *
 * There is no session yet, so the address the signature recovers to IS the
 * identity — it is checked against the `wallet` field the caller asked us to
 * register, which is what stops someone registering a wallet they do not hold.
 */
export function verifyRegistrationSignature(
  payload: SignedRegistration,
  opts?: VerifyOptions,
): Promise<VerifyResult> {
  return recoverAndCheck({
    primaryType: "Registration",
    typedData: {
      domain: HUNT_DOMAIN,
      types: REGISTRATION_TYPES,
      primaryType: "Registration",
      message: {
        wallet: payload.wallet,
        turboUsername: payload.turboUsername,
        passkeyCredentialId: payload.passkeyCredentialId,
        clientTs: payload.clientTs,
        nonce: payload.nonce,
      },
      signature: payload.signature,
    },
    signature: payload.signature,
    nonce: payload.nonce,
    clientTs: payload.clientTs,
    expectedAddress: payload.wallet,
    opts,
  });
}

/** Verify a login signature before minting a session cookie. */
export function verifySessionSignature(
  payload: SignedSession,
  opts?: VerifyOptions,
): Promise<VerifyResult> {
  if (payload.statement !== SESSION_STATEMENT) {
    return Promise.resolve({ ok: false, reason: "malformed" });
  }
  return recoverAndCheck({
    primaryType: "Session",
    typedData: {
      domain: HUNT_DOMAIN,
      types: SESSION_TYPES,
      primaryType: "Session",
      message: {
        wallet: payload.wallet,
        statement: payload.statement,
        clientTs: payload.clientTs,
        nonce: payload.nonce,
      },
      signature: payload.signature,
    },
    signature: payload.signature,
    nonce: payload.nonce,
    clientTs: payload.clientTs,
    expectedAddress: payload.wallet,
    opts,
  });
}

// --- Cota ------------------------------------------------------------------
//
// A Cota is the upper bound a player signs before software may trade for them.
// It reuses everything above unchanged: the same domain, the same single-use
// nonce, the same clock-skew window, and the same rule that the recovered
// address must equal the session player's wallet.
//
// That last check is what makes a Cota a bound rather than a suggestion. A
// signature is a bearer credential; without binding it to the session player,
// one player's signed ceiling would authorise trading in another's account.

export interface SignedCota {
  venue: string;
  markets: readonly string[];
  maxNotionalUsdE6: bigint;
  maxLeverageX100: bigint;
  maxDailyLossUsdE6: bigint;
  maxTradesPerDay: number;
  notBefore: bigint;
  notAfter: bigint;
  /** Unix SECONDS. */
  clientTs: bigint;
  nonce: string;
  signature: Hex;
  /** The session player's wallet. The recovered address must equal this. */
  expectedAddress: string;
}

export function verifyCotaSignature(
  payload: SignedCota,
  opts?: VerifyOptions,
): Promise<VerifyResult> {
  return recoverAndCheck({
    primaryType: "Cota",
    typedData: {
      domain: HUNT_DOMAIN,
      types: COTA_TYPES,
      primaryType: "Cota",
      message: {
        venue: payload.venue,
        // Spread: viem must not receive a readonly array where it expects a
        // mutable one, and the copy also stops a caller mutating the array
        // after we have hashed it.
        markets: [...payload.markets],
        maxNotionalUsdE6: payload.maxNotionalUsdE6,
        maxLeverageX100: payload.maxLeverageX100,
        maxDailyLossUsdE6: payload.maxDailyLossUsdE6,
        maxTradesPerDay: payload.maxTradesPerDay,
        notBefore: payload.notBefore,
        notAfter: payload.notAfter,
        clientTs: payload.clientTs,
        nonce: payload.nonce,
      },
      signature: payload.signature,
    },
    signature: payload.signature,
    nonce: payload.nonce,
    clientTs: payload.clientTs,
    expectedAddress: payload.expectedAddress,
    opts,
  });
}

/** Test seam. Never called from application code. */
export function __resetMemoryNonceStore(): void {
  memoryNonceStore.clear();
}
