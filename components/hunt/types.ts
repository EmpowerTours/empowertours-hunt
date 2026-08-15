import { OPAQUE_CLIENT_REASON } from "@/lib/hunt/validator";
import type { HintBand } from "@/lib/hunt/proximity";

/* ---------------------------------------------------------------------------
   Client-side view of the hunt API.

   Types are imported from the verifier rather than re-declared, so a band or a
   reject reason cannot drift out of sync with the code that produces it.

   SECURITY NOTE — read before adding a field.

   There is no `distanceMeters`, no `lat`, no `lng`, no `cacheId` and no
   specific reject reason anywhere in the cache-facing shapes below, and there
   must never be. The claim route collapses EVERY rejection to one opaque
   string on purpose (lib/hunt/validator.ts, `clientRejectBody`) because
   distinguishing "no cache here" from "you already have that one" is the exact
   bit an attacker needs to grid-search a hunt without walking. The hint
   endpoint is a deliberately blunt oracle for the same reason.

   Spawn coordinates ARE public and appear in `PublicSpawn` by design — that
   mechanic is "you can see it", and its defence is a short TTL plus movement
   plausibility, not secrecy. `PublicSpawn` is the ONLY shape in this file
   allowed to carry a coordinate.
--------------------------------------------------------------------------- */

export type { HintBand };
export { OPAQUE_CLIENT_REASON };

/** Ordered cold -> burning. */
export const BAND_ORDER = [
  "cold",
  "cool",
  "warm",
  "hot",
  "burning",
] as const satisfies readonly HintBand[];

/* --- Geolocation ---------------------------------------------------------- */

export interface GeoFix {
  lat: number;
  lng: number;
  /** Device-reported horizontal accuracy, meters. Never defaulted or invented. */
  accuracyM: number;
  headingDeg: number | null;
  speedMps: number | null;
  /** epoch ms of the fix itself, not of when we read it. */
  at: number;
}

export type GeoStatus =
  | "idle"
  | "unsupported"
  | "locating"
  | "ready"
  | "denied"
  | "unavailable"
  | "timeout";

/* --- Hint ----------------------------------------------------------------- */

/** `POST /api/hunt/[huntId]/hint` — band and count. Nothing else. */
export interface HintResponse {
  complete: boolean;
  band: HintBand | null;
  remaining: number;
}

/* --- Claim ---------------------------------------------------------------- */

/**
 * The EIP-712 message, mirroring `CLAIM_ATTEMPT_TYPES` in lib/auth/eip712.ts.
 * lat/lng/accuracyM are strings so the signed bytes are exactly the characters
 * the client sent — a float re-encoded on the way to the hasher is a signature
 * that verifies over a value nobody signed.
 */
export interface ClaimMessage {
  huntId: string;
  lat: string;
  lng: string;
  accuracyM: string;
  /** uint256 — epoch SECONDS, from the DEVICE clock. */
  clientTs: number;
  /** Single use, burned at consumption by the server's nonce store. */
  nonce: string;
}

export type ClaimSigner = (message: ClaimMessage) => Promise<`0x${string}`>;

export interface CacheReveal {
  label: string | null;
  blurb: string | null;
  photoCid: string | null;
}

export interface ClaimFound {
  found: true;
  findId: string;
  cache: CacheReveal;
  /** TURBO credit awarded, WMON-wei as a decimal string. Never a number. */
  rewardCreditWei: string;
  /** Running balance after this find, or null if the server did not say. */
  creditBalanceWei: string | null;
  /** THIS PLAYER's remaining caches — not a hunt-wide statistic. */
  remaining: number;
}

/**
 * What a refused claim can say.
 *
 * `no_find_here` is the ONLY reason the server will ever give, for every cause
 * from a bad fix to an exhausted budget. `rate_limited` and `unreachable` are
 * transport facts the client observes itself, not server judgements.
 */
export type ClaimRefusalReason =
  typeof OPAQUE_CLIENT_REASON | "rate_limited" | "unknown";

export interface ClaimRefused {
  found: false;
  reason: ClaimRefusalReason;
}

export type ClaimResponse = ClaimFound | ClaimRefused;

/* --- Hunt metadata -------------------------------------------------------- */

/**
 * The player-safe projection of a Hunt row.
 *
 * Deliberately excludes every budget, spend total and auto-approval bound: how
 * much treasury is left is an attacker's timing signal, not a player feature.
 */
export interface PublicHunt {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  startsAt: string | null;
  endsAt: string | null;
  /** Claims above this accuracy are refused server-side. Default 30. */
  maxAccuracyM: number;
  cooldownSeconds: number;
  spawnEnabled: boolean;
  spawnMaxRadiusM: number;
  remaining?: number;
}

/* --- Spawns --------------------------------------------------------------- */

/** Mirrors `SpawnView` in app/api/hunt/[huntId]/spawn/route.ts. */
export interface PublicSpawn {
  id: string;
  lat: number;
  lng: number;
  radiusMeters: number;
  /** Native MON in wei, decimal string. */
  amountMonWei: string;
  /** ISO 8601. */
  expiresAt: string;
  /** Commit half of the commit-reveal over the amount draw. */
  seedCommit: string;
}

/**
 * `POST /api/hunt/[huntId]/spawn` both REQUESTS a spawn and returns the live
 * ones. It is not a passive list — every call spends the player's `spawn` rate
 * limit (6/min), which the collect path shares.
 */
export interface SpawnScanResponse {
  spawned: boolean;
  /** Why no new spawn: `spawn_cooldown`, `hunt_budget_exhausted`, etc. */
  reason: string | null;
  spawns: PublicSpawn[];
}

export interface SpawnPayout {
  id: string;
  status: string;
  autoApproved: boolean;
  /** Non-null when a human has to release it. Honest about the wait. */
  holdReason: string | null;
}

export interface SpawnCollected {
  collected: true;
  spawnId: string;
  amountMonWei: string;
  /** sha256(seedReveal) === seedCommit — the player can audit the draw. */
  seedReveal: string;
  payout: SpawnPayout;
}

export interface SpawnRefused {
  collected: false;
  /** Spawn rejections carry their REAL reason; there is no secret to leak. */
  reason: string;
}

export type SpawnCollectResponse = SpawnCollected | SpawnRefused;

/* --- Session -------------------------------------------------------------- */

/** `GET /api/auth/session`. */
export interface SessionPlayerView {
  id: string;
  walletAddress: string;
  active: boolean;
  suspended: boolean;
}

/* --- Progress ------------------------------------------------------------- */

export interface PlayerProgress {
  /** TURBO credit balance, WMON-wei decimal string. Not withdrawable. */
  creditBalanceWei: string;
  /** Native MON collected from spawns, wei decimal string. */
  collectedMonWei: string;
  /** MON earned but not yet settled on chain. */
  pendingMonWei: string;
  findCount: number;
  spawnCount: number;
  turboUsername: string | null;
}
